# ERPNext v14 — Read-only, query-guarded MCP

A remote Cloudflare Worker MCP gateway for ERPNext/Frappe v14. **Development source only until the Worker builds, the ERP metadata script is installed, and integration tests succeed.** Committing to GitHub does not automatically connect ChatGPT or install ERP Server Scripts.

## Why index preflight is mandatory
The ERP database contains large tables. Before **every record read**, MCP fetches a fresh metadata profile through the manually installed GET-only API method `erp_mcp_table_profile`, which uses parameterized SELECTs against `information_schema.TABLES` and `information_schema.STATISTICS`. It checks:
- Approximate InnoDB table rows, data size and index size
- Existing index names and **ordered** columns (particularly the leading column)
- Allowed filters and supported indexed sorts
- At most 50 rows per request; at most 1,000 offset (200 for large tables)
- Medium tables (10,000+ estimated rows): require a leading-index filter
- Large tables (100,000+ estimated rows): require leading-index filter **and** <=31-day indexed date window
- Timeouts 8 seconds per upstream request and 150 KB response size limit
- If metadata is unavailable or malformed, fail closed; **no fallback unbounded scan**
- Date window on `creation`, `modified`, `encounter_date`, `appointment_date`, `posting_date`, or `start_date`

These are **conservative heuristics**, not an SQL cost guarantee. A leftmost index filter may still be unselective, and a table estimate can be stale. For expensive reports, manually review EXPLAIN, real cardinality, JOIN order, predicate selectivity and summary tables before exposing the report as a fixed, approved read-only endpoint. A client HTTP timeout alone does **not** stop a MariaDB query already running. The Frappe-side gateway should enforce database-side statement time budgets, or be backed by a separately permission-restricted read replica, before any heavy report is enabled.

## Included MCP tools

- `erp_capabilities`: allowed DocTypes/fields, safe query limits
- `erp_table_profile`: live row estimates and indexes
- `erp_query_plan`: preflight without fetching records
- `erp_list_records`: guarded GET /api/resource lookup, automatically calling preflight

The former `erp_count_records` that scanned up to 10,000 rows was removed. **No tool supports** arbitrary Python, SQL, System Console execution, mutations or unrestricted RPC.

## Mandatory ERPNext manual setup

1. Create a dedicated non-System-Manager integration user with a minimal role. Grant only Read on strictly needed DocTypes. Disable Write, Create, Delete, Submit, Cancel, Import, Export and privileged roles.
2. Review `erpnext/server_scripts/erp_mcp_table_profile.py` in GitHub.
3. Create a **Server Script** in ERPNext v14:
   - Script Type: `API`
   - API Method: `erp_mcp_table_profile`
   - Allow Guest: unchecked
   - Copy the reviewed Python source from the repository
   - Enable and Save manually
4. Test metadata as the dedicated integration user using a GET request to `/api/method/erp_mcp_table_profile?doctype=Patient%20Encounter`. Never share authentication secrets in messages.
5. Ensure the API method returns only the approved table's metadata. The restricted console may reject metadata SQL on your particular site; check the result manually. If this method fails, MCP data calls refuse to proceed.
6. Check the DocType list and actual v14 field names in `src/policy.ts` before production use.
7. In Cloudflare Worker secrets configure `ERP_BASE_URL=https://erp.erchms.com`, `ERP_API_KEY`, `ERP_API_SECRET` and a random high-entropy `MCP_ACCESS_TOKEN`.
8. Deploy GitHub `main` to your Cloudflare Worker `erpnext-mcp` and test `/health`, then authenticated MCP tool discovery, `erp_table_profile`, `erp_query_plan` and `erp_list_records`.

**Security note**: the API Server Script is manually installed, not pushed directly to ERP production. Cloudflare secret values must never appear in source code. Do not enable sensitive patient fields without explicit authorization. User access to metadata still requires a dedicated authenticated ERP identity.

## When a report is too expensive

1. Inspect table metadata and relevant indexes.
2. Draft a SELECT-only query with tenant/territory/hospital and bounded date predicates.
3. Manually inspect EXPLAIN on production-safe read-only access; reject broad scans or large intermediate joins.
4. If an index is missing, **recommend** the exact migration/index for manual review. MCP never runs ALTER/CREATE INDEX.
5. Prefer aggregate COUNT/SUM grouped in the database instead of fetching every patient record.
6. Break reports into narrow indexed date windows or use precomputed summary reports when needed.
7. Return a safety refusal and missing-index recommendation, rather than running a possibly damaging query.

## Version compatibility

Target Frappe 14.78.1, ERPNext 14.70.12, Healthcare 14.0.3, HRMS 14.29.1 and MariaDB 10.6.x. The API script is written for Frappe v14 Server Script safe_exec, uses no imports, and uses `frappe.response["message"]` instead of console `print()`.

## Cloudflare deployment note

Deploy using `npx wrangler deploy` in a GitHub-connected Cloudflare Worker. `wrangler.jsonc` must specify `erpnext-mcp`. A build that still reports `agents/mcp/server` is using an **older commit**, not current GitHub `main`. Check the GitHub commit SHA selected by Cloudflare before re-deploying.

## Current verification status

No live ERPNext credentials available here; I have not executed a production database query or verified a successful Worker build. Local package installation may be blocked by registry network access. Run `npm install && npm run check` (or the Cloudflare build) and review any errors before calling it production-ready.
