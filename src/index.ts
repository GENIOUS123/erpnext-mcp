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
  const analyticsDoctypes = ["Patient","Lead","Patient Appointment","Patient Encounter","Clinical Procedure","Sales Invoice"] as const;
  const groupings: Record<string,readonly string[]> = {
    "Patient":["territory","sex"],
    "Lead":["source","status","territory"],
    "Patient Appointment":["status","practitioner","department"],
    "Patient Encounter":["practitioner","company"],
    "Clinical Procedure":["practitioner","procedure_template","status"],
    "Sales Invoice":["docstatus","customer"]
  };
  const aggregateSchema=z.object({
    doctype:z.enum(analyticsDoctypes),
    date_from:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
    date_to_exclusive:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
    metric:z.enum(["count","sum_base_grand_total"]).default("count"),
    group_by:z.string().max(60).default(""),
    filter_field:z.string().max(60).default(""),
    filter_value:z.string().max(100).default("")
  });
  function validateAggregate(params:z.infer<typeof aggregateSchema>) {
    const start=Date.parse(params.date_from+"T00:00:00Z");
    const end=Date.parse(params.date_to_exclusive+"T00:00:00Z");
    const days=(end-start)/86400000;
    if(!Number.isInteger(days)||days<1||days>31) throw new Error("Date window must be 1-31 days");
    const groups=groupings[params.doctype];
    if(params.group_by&&!groups.includes(params.group_by))throw new Error("Group field is not approved");
    if(params.filter_field&&!groups.includes(params.filter_field))throw new Error("Filter field is not approved");
    if(Boolean(params.filter_field)!==Boolean(params.filter_value))throw new Error("Provide filter field AND value");
    if(params.metric==="sum_base_grand_total"&&params.doctype!=="Sales Invoice")throw new Error("SUM is approved only for Sales Invoice");
    if(params.doctype==="Sales Invoice"&&params.filter_field==="docstatus"&&!["0","1","2"].includes(params.filter_value))throw new Error("Invalid docstatus");
  }
  server.registerTool("erp_prepare_read_query",{
    description:"READ-ONLY PLANNING. Check the index and table size before a reusable aggregate query; returns the exact date/metric/group/filter requested. No patient data query is executed. Ask for the user's explicit approval before using erp_run_read_query.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:aggregateSchema
  },async(params)=>{
    try{
      validateAggregate(params);
      const p=await getProfile(env,params.doctype);
      const creationIdx=p.indexes.find(i=>i.columns[0]==="creation");
      if(!creationIdx)throw new Error("No leading creation index; refusing to plan aggregate");
      return output({query_ready:true,requires_user_approval:true,request:params,table_size_estimate:p.approximate_rows,index_name:creationIdx.index_name,server_will_check_explain:true,server_script:"erp_mcp_read_query"});
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_run_read_query",{
    description:"SENSITIVE LIVE READ. You MUST ask the user for explicit permission for this exact date/metric/filter/group request and WAIT for their answer BEFORE invoking. Also configure the ChatGPT app permission to Always ask. Reusable backend-constructed parameterized SELECT aggregation only; rejects arbitrary SQL/Python, non-indexed or unsafe EXPLAIN plans. Not a general System Console executor.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:aggregateSchema
  },async(params)=>{
    try{
      validateAggregate(params);
      const p=await getProfile(env,params.doctype);
      if(!p.indexes.some(i=>i.columns[0]==="creation"))throw new Error("No creation leading index; refusing query");
      const result=await erpGet(env,"/api/method/erp_mcp_read_query",{
        doctype:params.doctype,date_from:params.date_from,date_to:params.date_to_exclusive,
        metric:params.metric,group_by:params.group_by,filter_field:params.filter_field,
        filter_value:params.filter_value
      });
      return output(result?.message??result);
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_count_patients",{
    description:"SENSITIVE LIVE DATABASE READ. Before calling, explicitly ask the user for permission to run this specific Patient COUNT with the exact date range, and wait for approval. User should configure ChatGPT permission mode Always ask. Only calls an approved parameterized, read-only, index-checked ERPNext v14 count endpoint; never executes user SQL.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:z.object({
      date_from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive ERPNext site-local date (YYYY-MM-DD)"),
      date_to_exclusive:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Exclusive ERPNext site-local date (YYYY-MM-DD)")
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
