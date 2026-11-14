import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FIELDS, assertFields, fieldsFor, validateFilters } from "./policy";

interface Env {
  ERP_BASE_URL: string;
  ERP_API_KEY: string;
  ERP_API_SECRET: string;
  MCP_ACCESS_TOKEN: string;
}
function resourceUrl(env: Env, doctype: string, params: Record<string, string>): URL {
  const base = new URL(env.ERP_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("ERP_BASE_URL must be clean HTTPS");
  const url = new URL("/api/resource/" + encodeURIComponent(doctype), base.origin);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return url;
}
async function erpGet(env: Env, doctype: string, params: Record<string,string>): Promise<unknown> {
  const url = resourceUrl(env, doctype, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: "token " + env.ERP_API_KEY + ":" + env.ERP_API_SECRET, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("ERP request failed (HTTP " + response.status + ")");
    const raw = await response.text();
    if (raw.length > 250000) throw new Error("ERP response exceeded size limit");
    return JSON.parse(raw);
  } finally { clearTimeout(timeout); }
}
function output(v: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(v) }] };
}
function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "erpnext-v14-readonly", version: "0.1.0" });
  server.registerTool("erp_capabilities", {
    description: "List strictly allowlisted ERPNext v14 DocTypes and readable fields; never modifies ERP data.",
    inputSchema: z.object({})
  }, async () => output({ mode: "read-only", doctypes: FIELDS, max_page_size: 100 }));
  server.registerTool("erp_list_records", {
    description: "Fetch permitted ERPNext records using Frappe v14's GET /api/resource. Explicit field, filter and page allowlists apply. No writes or SQL.",
    inputSchema: z.object({
      doctype: z.string().min(1).max(80),
      fields: z.array(z.string()).min(1).max(24),
      filters: z.array(z.tuple([z.string(), z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])])).max(12).default([]),
      limit_start: z.number().int().min(0).max(100000).default(0),
      limit_page_length: z.number().int().min(1).max(100).default(25),
      order_by: z.enum(["creation asc","creation desc","modified asc","modified desc","name asc","name desc"]).default("creation desc")
    })
  }, async ({doctype,fields,filters,limit_start,limit_page_length,order_by}) => {
    try {
      const requested = assertFields(doctype, fields);
      if (!fieldsFor(doctype).includes(order_by.split(" ")[0])) throw new Error("Order field is not allowlisted");
      const safeFilters = validateFilters(doctype, filters);
      const result = await erpGet(env,doctype,{
        fields: JSON.stringify(requested),
        filters: JSON.stringify(safeFilters),
        limit_start: String(limit_start),
        limit_page_length: String(limit_page_length),
        order_by
      });
      return output(result);
    } catch(e) { return { isError: true, ...output({error: e instanceof Error ? e.message : "Query rejected"}) }; }
  });
  server.registerTool("erp_count_records", {
    description: "Count permitted ERPNext records using GET /api/resource with only name field, paginated. Use filtered list queries for exact aggregates. Max 10000 rows per count.",
    inputSchema: z.object({
      doctype: z.string().min(1).max(80),
      filters: z.array(z.tuple([z.string(), z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])])).max(12).default([])
    })
  }, async ({doctype,filters}) => {
    try {
      fieldsFor(doctype);
      const safeFilters=validateFilters(doctype,filters);
      // Count via pagination; avoids exposing unrestricted frappe.client.get_count method calls.
      let total=0;
      for (let offset=0;offset<10000;offset+=100) {
        const result = await erpGet(env,doctype,{ fields:'["name"]',filters:JSON.stringify(safeFilters),limit_start:String(offset),limit_page_length:"100",order_by:"name asc" }) as {data?: unknown[]};
        const n=Array.isArray(result.data)?result.data.length:0;
        total+=n;
        if(n<100) return output({doctype,count:total,truncated:false});
      }
      return output({doctype,count_at_least:10000,truncated:true});
    } catch(e) { return {isError:true,...output({error:e instanceof Error?e.message:"Query rejected"})};}
  });
  return server;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return new Response(JSON.stringify({status:"ok", mode:"read-only"}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    if (!env.MCP_ACCESS_TOKEN || !env.ERP_API_KEY || !env.ERP_API_SECRET || !env.ERP_BASE_URL)
      return new Response("Not configured", {status:503});
    if (request.headers.get("Authorization") !== "Bearer " + env.MCP_ACCESS_TOKEN)
      return new Response("Unauthorized",{status:401,headers:{"WWW-Authenticate":'Bearer realm="erpnext-mcp"'}});
    if(new URL(request.url).pathname !== "/mcp") return new Response("Not Found",{status:404});
    return createMcpHandler(() => createServer(env), {maxRequestBodySize:65536}).fetch(request);
  }
} satisfies ExportedHandler<Env>;
