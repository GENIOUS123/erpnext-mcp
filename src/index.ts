import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FIELDS, assertFields, fieldsFor, validateFilters, type Filter } from "./policy";
import { planQuery, assertProfile, type TableProfile, MAX_ROWS } from "./query-guard";

interface Env {
  ERP_BASE_URL: string;
  ERP_API_KEY: string;
  ERP_API_SECRET: string;
  MCP_ACCESS_TOKEN: string;
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
  const server=new McpServer({name:"erpnext-v14-readonly",version:"0.2.0"});
  server.registerTool("erp_capabilities",{
    description:"Read-only, index-aware ERPNext tools and approved fields. Requires installed metadata API.",
    inputSchema:z.object({})
  },async()=>output({mode:"read-only",doctypes:FIELDS,max_page_size:MAX_ROWS,metadata_endpoint:"erp_mcp_table_profile",large_table_threshold:100000}));
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
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==="/health")return new Response(JSON.stringify({status:"ok",mode:"read-only",requires_profile_endpoint:true}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    if(path!=="/mcp")return new Response("Not Found",{status:404});
    if(!env.MCP_ACCESS_TOKEN||!env.ERP_API_KEY||!env.ERP_API_SECRET||!env.ERP_BASE_URL)
      return new Response("Not configured",{status:503});
    if(request.headers.get("Authorization")!=="Bearer "+env.MCP_ACCESS_TOKEN)
      return new Response("Unauthorized",{status:401,headers:{"WWW-Authenticate":'Bearer realm="erpnext-mcp"'}});
    return createMcpHandler(()=>createServer(env)).fetch(request);
  }
} satisfies ExportedHandler<Env>;
