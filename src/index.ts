import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { GitHubHandler } from "./github-handler";
import { z } from "zod";
import { FIELDS, assertFields, fieldsFor, validateFilters, type Filter } from "./policy";
import { planQuery, assertProfile, type TableProfile, MAX_ROWS } from "./query-guard";

const BUILD_ID = "universal-debug-20261114-1";
const REGISTERED_TOOL_NAMES = ["erp_connection_status","erp_capabilities","erp_prepare_read_query","erp_run_read_query","erp_universal_read","erp_universal_diagnostics","erp_table_profile","erp_query_plan","erp_list_records"] as const;

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
async function erpPost(env:Env,path:string,params:Record<string,string>):Promise<any>{
  if(!env.ERP_API_KEY||!env.ERP_API_SECRET||!env.ERP_BASE_URL)
    throw new Error("ERPNext API bindings are not configured on the Worker");
  const url=new URL(path,baseUrl(env).origin);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(url.toString(),{
      method:"POST",
      headers:{
        Authorization:"token "+env.ERP_API_KEY+":"+env.ERP_API_SECRET,
        Accept:"application/json",
        "Content-Type":"application/x-www-form-urlencoded"
      },
      body:new URLSearchParams(params).toString(),
      redirect:"manual",signal:controller.signal
    });
    if(response.status>=300&&response.status<400)
      throw new Error("ERP endpoint redirected (HTTP "+response.status+")");
    const raw=await response.text();
    if(!response.ok){
      // Errors may contain sensitive traceback or patient data; return only
      // Frappe's safe message field where available, otherwise HTTP status.
      let detail="";
      try{
        const parsed=JSON.parse(raw);
        if(typeof parsed?.message==="string")
          detail=": "+parsed.message.slice(0,300);
        else if(typeof parsed?.exception==="string")
          detail=": "+parsed.exception.slice(0,200);
      }catch{}
      console.error("erp_universal_read upstream error",JSON.stringify({build_id:BUILD_ID,stage:"erp_api_call",http_status:response.status,api_method:"erp_mcp_universal_read"}));
      throw new Error("ERP universal endpoint failed (HTTP "+response.status+")"+detail);
    }
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
    build_id:BUILD_ID,
    registered_tools:[...REGISTERED_TOOL_NAMES],
    universal_tool_registered:true,
    universal_api_method:"erp_mcp_universal_read",
    note:"Tool registry is from this Worker build; backend availability is checked by erp_universal_diagnostics."
  }));
  server.registerTool("erp_capabilities",{
    description:"Read-only ERPNext tools and approved fields. Requires installed metadata API.",
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
    description:"READ-ONLY PLANNING. Validate the date/metric/group/filter requested. No patient data query is executed. Ask for the user's explicit approval before using erp_run_read_query.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:aggregateSchema
  },async(params)=>{
    try{
      validateAggregate(params);
      return output({query_ready:true,requires_user_approval:true,request:params,server_script:"erp_mcp_read_query",note:"No index precondition; backend database timeout policy still applies."});
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_run_read_query",{
    description:"SENSITIVE LIVE READ. You MUST ask the user for explicit permission for this exact date/metric/filter/group request and WAIT for their answer BEFORE invoking. Also configure the ChatGPT app permission to Always ask. Reusable backend-constructed parameterized SELECT aggregation only; rejects arbitrary SQL/Python, queries missing server-side timeout enforcement. Not a general System Console executor.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:aggregateSchema
  },async(params)=>{
    try{
      validateAggregate(params);
      const result=await erpGet(env,"/api/method/erp_mcp_read_query",{
        doctype:params.doctype,date_from:params.date_from,date_to:params.date_to_exclusive,
        metric:params.metric,group_by:params.group_by,filter_field:params.filter_field,
        filter_value:params.filter_value
      });
      return output(result?.message??result);
    }catch(e){return rejected(e);}
  });
  // Structured universal SELECT: identifiers are verified against live
  // information_schema.COLUMNS by the ERPNext API, never interpolated directly.
  // A separate schema mode allows discovering custom links before building joins.
  const universalScalar=z.union([z.string(),z.number(),z.boolean()]);
  const universalField=z.string().min(3).max(100);
  const universalSchema=z.object({
    mode:z.enum(["schema","query"]),
    doctype:z.string().max(90).optional(),
    query:z.object({
      base:z.string().min(1).max(90),
      alias:z.string().min(1).max(16).default("t"),
      date_from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      date_to_exclusive:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      fields:z.array(universalField).max(20).default([]),
      joins:z.array(z.object({
        doctype:z.string().min(1).max(90),
        alias:z.string().min(1).max(16),
        type:z.enum(["left","inner"]).default("left"),
        left:universalField,
        right:universalField
      })).max(3).default([]),
      filters:z.array(z.object({
        field:universalField,
        op:z.enum(["=","!=",">",">=","<","<=","like","in","is_null","is_not_null"]),
        value:z.union([universalScalar,z.array(universalScalar)]).optional()
      })).max(12).default([]),
      metrics:z.array(z.object({
        fn:z.enum(["count","count_distinct","sum","min","max","avg"]),
        field:universalField.optional(),
        as:z.string().min(1).max(16).default("total")
      })).max(5).default([]),
      group_by:z.array(universalField).max(6).default([]),
      order_by:z.array(z.object({
        field:z.string().min(1).max(100),
        direction:z.enum(["asc","desc"]).default("asc")
      })).max(3).default([]),
      limit:z.number().int().min(1).max(100).default(50),
      offset:z.number().int().min(0).max(1000).default(0)
    }).optional()
  }).superRefine((v,ctx)=>{
    if(v.mode==="schema"&&!v.doctype)
      ctx.addIssue({code:"custom",message:"doctype is required for schema mode"});
    if(v.mode==="query"&&!v.query)
      ctx.addIssue({code:"custom",message:"query object is required for query mode"});
  });
  server.registerTool("erp_universal_read",{
    description:"Universal, structured READ-ONLY ERPNext data tool. mode=schema reveals real DB columns and Link/Custom Link fields for a DocType without reading patient records. mode=query can SELECT up to 100 rows, join up to 3 approved DocTypes, filter, group and aggregate within a mandatory 1-31 day creation window. No raw SQL or writes, no mandatory index. Query mode accesses live records: ask the user for explicit approval of the exact scope before execution (configure ChatGPT App permission Always ask). Prefer schema discovery before joins to avoid guessing field names. Requires manually installed ERPNext Server Script erp_mcp_universal_read and a dedicated least-privilege API identity.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:universalSchema
  },async(params)=>{
    try{
      const payload=params.mode==="schema"
        ?{mode:"schema",doctype:params.doctype}
        :{mode:"query",query:params.query};
      const result=await erpPost(env,"/api/method/erp_mcp_universal_read",{payload:JSON.stringify(payload)});
      return output(result?.message??result);
    }catch(e){return rejected(e);}
  });
  server.registerTool("erp_universal_diagnostics",{
    description:"Safe diagnostics for the universal read bridge. Confirms active Worker build and performs schema-only probe of ERPNext erp_mcp_universal_read. Returns stage, HTTP status and sanitized error classification, never patient data or credentials. No live record read.",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:z.object({doctype:z.enum(["Clinical Procedure","Sales Invoice","Sales Invoice Item"]).default("Clinical Procedure")})
  },async({doctype})=>{
    const info={build_id:BUILD_ID,universal_tool_registered:true,api_method:"erp_mcp_universal_read",doctype};
    if(!env.ERP_API_KEY||!env.ERP_API_SECRET||!env.ERP_BASE_URL)
      return output({...info,ok:false,stage:"worker_configuration",error_code:"MISSING_ERP_CREDENTIALS"});
    try{
      const result=await erpPost(env,"/api/method/erp_mcp_universal_read",{
        payload:JSON.stringify({mode:"schema",doctype})
      });
      const msg=result?.message??result;
      if(msg?.success!==true||!Array.isArray(msg?.columns))
        return output({...info,ok:false,stage:"erp_response_validation",error_code:"UNEXPECTED_SCHEMA_RESPONSE"});
      return output({...info,ok:true,stage:"complete",column_count:msg.columns.length,
        link_field_count:Array.isArray(msg.link_fields)?msg.link_fields.length:null});
    }catch(e){
      const err=e instanceof Error?e.message:"Unknown backend error";
      const statusMatch=err.match(/HTTP (\d{3})/);
      const status=statusMatch?Number(statusMatch[1]):null;
      let error_code="UPSTREAM_FAILURE";
      if(status===401||status===403)error_code="ERP_AUTHORIZATION_FAILURE";
      else if(status===404)error_code="ERP_METHOD_NOT_FOUND";
      else if(status===500)error_code="ERP_SERVER_EXCEPTION";
      else if(err.includes("aborted")||err.includes("AbortError"))error_code="ERP_HTTP_TIMEOUT";
      else if(err.includes("fetch"))error_code="ERP_NETWORK_FAILURE";
      return output({...info,ok:false,stage:"erp_api_call",http_status:status,error_code});
    }
  });
  server.registerTool("erp_table_profile",{
    description:"Read live approximate table size (InnoDB estimates), data/index size and existing composite indexes before planning any new query.",
    inputSchema:z.object({doctype:z.string().min(1).max(80)})
  },async({doctype})=>{try{return output(await getProfile(env,doctype));}catch(e){return rejected(e);}});
  server.registerTool("erp_query_plan",{
    description:"Read-only query preflight for allowlisted fields, valid filters and bounded pagination; no index required.",
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
    description:"Read-only allowlisted record retrieval with strict page and offset limits; no index required.",
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
      return new Response(JSON.stringify({status:"ok",service:"erpnext-mcp",mode:"read-only",oauth:true,mcp_path:"/mcp",build_id:BUILD_ID,universal_tool_registered:true,registered_tool_count:REGISTERED_TOOL_NAMES.length}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
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
