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
  if(!env.ERP_API_KEY||!env.ERP_API_SECRET||!env.ERP_BASE_URL)
    throw new Error("ERPNext API bindings are not configured on the Worker");
  const url=new URL(path,baseUrl(env).origin);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(url.toString(),{
      method:"GET",
      headers:{Authorization:"token "+env.ERP_API_KEY+":"+env.ERP_API_SECRET,Accept:"application/json"},
      redirect:"manual",
      signal:controller.signal
    });
    // Do not follow redirects: ERP requests must stay on the configured HTTPS origin.
    if(response.status>=300&&response.status<400)
      throw new Error("ERP endpoint returned HTTP redirect ("+response.status+"); refusing to follow");
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
  const allowedGithubId = String(env.GITHUB_ALLOWED_USER_ID || "").trim();
  if (!allowedGithubId || !props || props.githubId !== allowedGithubId) {
    throw new Error("Unauthorized GitHub account");
  }
  const server=new McpServer({name:"erpnext-v14-readonly",version:"0.2.0"});
  server.registerTool("erp_connection_status",{
    description:"Read-only MCP connectivity diagnostic: confirms OAuth identity and reports whether required ERPNext API environment bindings are present, without revealing their values. Does not query ERPNext.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:z.object({})
  },async()=>output({
    oauth_authenticated:true,
    github_user_authorized:true,
    erp_configuration_present:Boolean(env.ERP_BASE_URL&&env.ERP_API_KEY&&env.ERP_API_SECRET),
    read_only:true,
    gateway_api_method:"erp_mcp_read_query",
    note:"ERPNext Server Script installation and DB timeout need a separate live test"
  }));
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
    date_from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_to_exclusive:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
  // Exception is deliberately limited to an exact one-day Patient COUNT.
  // It uses a separate, database-time-limited ERP endpoint, never the general
  // read-query API. This does NOT relax normal record-list safety checks.
  function isDailyPatientCountFallback(params:z.infer<typeof aggregateSchema>):boolean {
    if(params.doctype!=="Patient"||params.metric!=="count"||
       params.group_by||params.filter_field||params.filter_value)return false;
    const start=Date.parse(params.date_from+"T00:00:00Z");
    const end=Date.parse(params.date_to_exclusive+"T00:00:00Z");
    return Number.isFinite(start)&&Number.isFinite(end)&&
      end-start===86400000&&
      new Date(start).toISOString().slice(0,10)===params.date_from&&
      new Date(end).toISOString().slice(0,10)===params.date_to_exclusive;
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
      if(!creationIdx){
        if(!isDailyPatientCountFallback(params))throw new Error("No leading creation index; refusing to plan aggregate");
        // Do not claim that ERPNext is ready: the separate timeout-protected
        // endpoint must be installed and tested by an administrator.
        return output({query_ready:false,requires_user_approval:true,request:params,
          table_size_estimate:p.approximate_rows,fallback:"bounded_patient_daily_count",
          requires_backend_setup:true,server_script:"erp_mcp_daily_patient_count",
          warning:"Install and validate the MariaDB statement-time-limited endpoint before execution. No unindexed query was executed."});
      }
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
      if(!p.indexes.some(i=>i.columns[0]==="creation")){
        if(!isDailyPatientCountFallback(params))throw new Error("No creation leading index; refusing query");
        // Dedicated, fixed-COUNT endpoint must apply a MariaDB per-statement
        // timeout. Missing backend method fails closed, not via general API.
        const fallback=await erpGet(env,"/api/method/erp_mcp_daily_patient_count",{
          date_from:params.date_from,date_to_exclusive:params.date_to_exclusive
        });
        const data=fallback?.message;
        if(data?.bounded_fallback!==true||data?.doctype!=="Patient"||
           data?.metric!=="count"||data?.date_from!==params.date_from||
           data?.date_to_exclusive!==params.date_to_exclusive||
           typeof data?.total!=="number"||!Number.isSafeInteger(data.total)||data.total<0)
          throw new Error("Daily count backend did not return an approved bounded response");
        return output(data);
      }
      const result=await erpGet(env,"/api/method/erp_mcp_read_query",{
        doctype:params.doctype,date_from:params.date_from,date_to:params.date_to_exclusive,
        metric:params.metric,group_by:params.group_by,filter_field:params.filter_field,
        filter_value:params.filter_value
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
    // OAuthProvider has already verified the MCP bearer token. Do not hide
    // tool discovery when ERP credentials are missing; guarded ERP calls fail
    // closed inside erpGet instead, with an actionable configuration error.
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
