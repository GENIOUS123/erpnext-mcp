import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { GitHubHandler } from "./github-handler";
import { z } from "zod";
import { FIELDS, assertFields, fieldsFor, validateFilters, type Filter } from "./policy";
import { planQuery, assertProfile, type TableProfile, MAX_ROWS } from "./query-guard";

interface Env {
  ERP_BASE_URL: string;
  ERP_API_KEY: string;
  ERP_API_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ALLOWED_USER_ID: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
}
function baseUrl(env:Env):URL {
  const base=new URL(env.ERP_BASE_URL);
  if(base.protocol!=="https:"||base.username||base.password||base.search||base.hash||base.pathname!=="/")
    throw new Error("ERP_BASE_URL must be a clean HTTPS origin");
  return base;
}
async function erpGet(env:Env,path:string,params:Record<string,string>):Promise<any>{
  const url=new URL(path,baseUrl(env).origin);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(url.toString(),{
      method:"GET",
      headers:{Authorization:"token "+env.ERP_API_KEY+":"+env.ERP_API_SECRET,Accept:"application/json"},
      redirect:"error",
      signal:controller.signal
    });
    if(!response.ok)throw new Error("ERP endpoint failed (HTTP "+response.status+")");
    const raw=await response.text();
    if(raw.length>150000)throw new Error("ERP response exceeds 150KB");
    return JSON.parse(raw);
  }finally{clearTimeout(timeout);}
}
async function getProfile(env:Env,doctype:string):Promise<TableProfile>{
  fieldsFor(doctype);
  // No fallback: the live metadata API must be installed and reachable.
  const result=await erpGet(env,"/api/method/erp_mcp_table_profile",{doctype});
  const profile=result?.message as TableProfile;
  assertProfile(profile,doctype);
  return profile;
}
function output(v:unknown){return {content:[{type:"text" as const,text:JSON.stringify(v)}]};}
function rejected(e:unknown){return {isError:true,...output({error:e instanceof Error?e.message:"Query rejected"})};}
const filterValue=z.union([z.string(),z.number(),z.boolean(),z.array(z.union([z.string(),z.number(),z.boolean()]))]);
const filtersSchema=z.array(z.tuple([z.string(),z.string(),filterValue])).max(8).default([]);
function createServer(env:Env):McpServer{
  // OAuthProvider validates tokens, while GitHubHandler only issues them to the approved account.
  // Never expose ERP tools to a missing or unrelated OAuth identity.
  const auth = getMcpAuthContext();
  const props = auth?.props as { githubId?: string } | undefined;
  if (!env.GITHUB_ALLOWED_USER_ID || !props || props.githubId !== env.GITHUB_ALLOWED_USER_ID) {
    throw new Error("Unauthorized GitHub account");
  }
  const server=new McpServer({name:"erpnext-v14-readonly",version:"0.2.0"});
  server.registerTool("erp_capabilities",{
    description:"Read-only, index-aware ERPNext tools and approved fields. Requires installed metadata API.",
    inputSchema:z.object({})
  },async()=>output({mode:"read-only",doctypes:FIELDS,max_page_size:MAX_ROWS,metadata_endpoint:"erp_mcp_table_profile",large_table_threshold:100000}));
  server.registerTool("erp_count_patients",{
    description:"SENSITIVE LIVE DATABASE READ. Before calling, explicitly ask the user for permission to run this specific Patient COUNT with the exact date range, and wait for approval. User should configure ChatGPT permission mode Always ask. Only calls an approved parameterized, read-only, index-checked ERPNext v14 count endpoint; never executes user SQL.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:z.object({
      date_from:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).describe("Inclusive ERPNext site-local date (YYYY-MM-DD)"),
      date_to_exclusive:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).describe("Exclusive ERPNext site-local date (YYYY-MM-DD)")
    })
  },async({date_from,date_to_exclusive})=>{
    try{
      const start=Date.parse(date_from+"T00:00:00Z");
      const end=Date.parse(date_to_exclusive+"T00:00:00Z");
      const span=(end-start)/86400000;
      if(!Number.isFinite(span)||!Number.isInteger(span)||span<1||span>31)throw new Error("Date window must be 1 to 31 days");
      // The backend enforces Patient Read permission, leading creation index
      // presence, and parameterized aggregate-only SQL, independently.
      const result=await erpGet(env,"/api/method/erp_mcp_count_patients",{
        date_from,date_to:date_to_exclusive
      });
      return output(result?.message??result);
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_table_profile",{
    description:"Read live approximate table size (InnoDB estimates), data/index size and existing composite indexes before planning any new query.",
    inputSchema:z.object({doctype:z.string().min(1).max(80)})
  },async({doctype})=>{try{return output(await getProfile(env,doctype));}catch(e){return rejected(e);}});
  server.registerTool("erp_query_plan",{
    description:"Mandatory safe-query preflight. Examines live table size, index leading columns, page budget, and 31-day indexed date bound; does not fetch records.",
    inputSchema:z.object({
      doctype:z.string().min(1).max(80),
      fields:z.array(z.string()).min(1).max(16),
      filters:filtersSchema,
      limit_start:z.number().int().min(0).max(1000).default(0),
      limit_page_length:z.number().int().min(1).max(MAX_ROWS).default(25),
      order_by:z.enum(["creation asc","creation desc","modified asc","modified desc","name asc","name desc"]).default("creation desc")
    })
  },async({doctype,fields,filters,limit_start,limit_page_length,order_by})=>{
    try{
      const safeFields=assertFields(doctype,fields);
      const safeFilters=validateFilters(doctype,filters as Filter[]);
      const profile=await getProfile(env,doctype);
      return output(planQuery(profile,safeFilters,safeFields,order_by,limit_start,limit_page_length));
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_list_records",{
    description:"Index-aware read-only record retrieval. Automatically checks live information_schema metadata and fails closed for unsafe scans, missing indexes, long date windows or deep pagination.",
    inputSchema:z.object({
      doctype:z.string().min(1).max(80),
      fields:z.array(z.string()).min(1).max(16),
      filters:filtersSchema,
      limit_start:z.number().int().min(0).max(1000).default(0),
      limit_page_length:z.number().int().min(1).max(MAX_ROWS).default(25),
      order_by:z.enum(["creation asc","creation desc","modified asc","modified desc","name asc","name desc"]).default("creation desc")
    })
  },async({doctype,fields,filters,limit_start,limit_page_length,order_by})=>{
    try{
      const safeFields=assertFields(doctype,fields);
      const safeFilters=validateFilters(doctype,filters as Filter[]);
      const profile=await getProfile(env,doctype);
      const decision=planQuery(profile,safeFilters,safeFields,order_by,limit_start,limit_page_length);
      const result=await erpGet(env,"/api/resource/"+encodeURIComponent(doctype),{
        fields:JSON.stringify(safeFields),
        filters:JSON.stringify(safeFilters),
        limit_start:String(limit_start),
        limit_page_length:String(limit_page_length),
        order_by
      });
      return output({query_safety:decision,data:result?.data??[]});
    }catch(e){return rejected(e);}
  });
  return server;
}
const mcpHandler = createMcpHandler(() => createServer(env as Env));
const apiHandler = {
  fetch(request:Request, bindings:Env, ctx:ExecutionContext) {
    if(new URL(request.url).pathname==="/health")
      return new Response(JSON.stringify({status:"ok",mode:"read-only",oauth:true}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    if(!bindings.ERP_API_KEY||!bindings.ERP_API_SECRET||!bindings.ERP_BASE_URL||!bindings.GITHUB_ALLOWED_USER_ID)
      return new Response("Not configured",{status:503});
    return mcpHandler(request,bindings,ctx);
  }
} satisfies ExportedHandler<Env>;
export default new OAuthProvider<Env>({
  apiHandler,
  apiRoute:"/mcp",
  authorizeEndpoint:"/authorize",
  clientRegistrationEndpoint:"/register",
  defaultHandler:GitHubHandler as any,
  tokenEndpoint:"/token",
  resourceMetadata:{resource:"https://mcp.erclens.com/mcp"}
});
