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


## GitHub OAuth on main (November 14, 2026)

GitHub OAuth source is now on `main` using the Cloudflare Workers OAuth Provider and Cloudflare's reference GitHub authentication handler. The MCP access token is no longer used to authenticate MCP clients. **Not live until the following Cloudflare configuration is completed and the Worker build/authorization flow have been tested.**

1. Cloudflare Dashboard → Storage & databases → KV → Create namespace: `erpnext-mcp-oauth`.
2. Copy its namespace ID (not a secret) and add this entry to `wrangler.jsonc`:
   ```json
   "kv_namespaces": [{"binding":"OAUTH_KV","id":"YOUR_ACTUAL_KV_NAMESPACE_ID"}]
   ```
   Do **not** use a placeholder ID when deploying. Either commit the real KV ID to GitHub (it isn't a credential) or have the owner supply it for update. Without this binding, OAuth routes cannot work.
3. Worker → Settings → Variables and Secrets:
   - `GITHUB_CLIENT_ID` (Secret)
   - `GITHUB_CLIENT_SECRET` (Secret)
   - `GITHUB_ALLOWED_USER_ID` (Variable/Secret): the **numeric** GitHub account ID of the only approved person, **not** the GitHub username. To find it: authenticate to GitHub and inspect GitHub account profile API `https://api.github.com/users/YOUR_USERNAME`, field `id`.
   - `COOKIE_ENCRYPTION_KEY` (Secret): `openssl rand -hex 32`
   - Keep `ERP_BASE_URL`, `ERP_API_KEY`, `ERP_API_SECRET`.
   - Legacy `MCP_ACCESS_TOKEN` is no longer used by the OAuth MCP route.
4. Configure the GitHub OAuth application callback URL as `https://mcp.erclens.com/callback`.
5. Deploy `main`. Test `https://mcp.erclens.com/.well-known/oauth-authorization-server` and `https://mcp.erclens.com/.well-known/oauth-protected-resource` and check the `/mcp` response has OAuth Bearer challenge metadata.
6. In ChatGPT, choose OAuth for `https://mcp.erclens.com/mcp` and approve after signing into the allowed GitHub account.

**Security:** OAuth tokens are issued only after the GitHub API returns the configured numeric user ID. The MCP tool factory also checks the bound GitHub ID before exposing any ERP data tools. ERP tool implementations retain mandatory index/table-size inspection and strictly read-only GET requests.

**Critical:** This is a source update; it has not been verified to build or run in your account. If the Cloudflare deployment log reports missing `OAUTH_KV`, create the binding first, then redeploy. Keep the previous working deployment until configuration and tests succeed.

## Patient counts with explicit per-query approval

A new tool `erp_count_patients` performs a **database-side aggregate COUNT**, not a client-side scan/pagination loop. For example, to count Patients created on 14 November 2026, the permitted date parameters are:
- `date_from=2026-11-14`
- `date_to_exclusive=2026-11-15`

The corresponding **fixed** SQL is:

```sql
SELECT COUNT(*) AS total
FROM `tabPatient`
WHERE creation >= %s AND creation < %s
```

Values are parameterized. The MCP tool accepts **only dates**, never arbitrary SQL or Python. The ERPNext Server Script must check permission and a leading `creation` index before executing the SELECT.

### Manual ERP installation (required)

1. Review `erpnext/server_scripts/erp_mcp_count_patients.py`.
2. In ERPNext v14, create a **Server Script**, type **API**, API Method `erp_mcp_count_patients`, **Allow Guest unchecked**.
3. Paste the script, save and enable manually. Keep the integration user's Patient Read permissions minimal.
4. If the creation index is absent, the script refuses the count; ask an administrator to review indexing manually. The MCP never creates indexes.
5. Configure a **database-side max statement time** for the integration's SQL execution path before running heavy reports. A Cloudflare HTTP timeout does not cancel an already-running MariaDB query.

### Require approval on every query

Set the **ChatGPT plugin's permission mode to Always ask** for the actual connected ERPNext MCP plugin. The tool description independently instructs the assistant to ask the user and wait for explicit approval of each requested date range. This is an approval **policy**, not a cryptographic authorization guarantee: the Worker cannot verify a user confirmation originating from ChatGPT. If hard server-side approval is required, implement an external approval/token workflow before enabling broad analytic SQL. Do not claim a boolean argument or a model prompt constitutes secure user consent.

### Important scope

The new tool handles Patient creation counts only. More aggregations should be added as separately reviewed, fixed, parameterized, read-only endpoints with indexed predicates and narrow date windows. **Do not expose an arbitrary SQL executor or a generic System Console API.**


## Reusable read-only aggregate gateway (2026-11-14)

**Added to `main`:** `erp_prepare_read_query` and `erp_run_read_query` using a *single manually installed* ERPNext v14 Server Script, [`erpnext/server_scripts/erp_mcp_read_query.py`](erpnext/server_scripts/erp_mcp_read_query.py). This is a controlled SQL **query builder**, not remote Python System Console or arbitrary SQL execution.

### Manual one-time ERPNext setup
1. Review the backend script, then create **one** Server Script (Type API, Method `erp_mcp_read_query`, Allow Guest OFF).
2. Paste the Python source and save. It contains only parameterized SELECT, index metadata and EXPLAIN. No DB schema/data mutation.
3. Use a non-admin read-only ERPNext integration account. Note: `frappe.db.sql` bypasses Frappe row-level restrictions; the script only checks DocType Read and may return cross-location aggregates. Do not give the account access to DocTypes/data it should not aggregate.
4. **Database administration prerequisite:** The API checks `SELECT @@max_statement_time` and **refuses to execute** unless the current MariaDB session reports a timeout of more than zero and no more than 5 seconds. Set this on an **isolated database connection/reader** or read replica, not globally on the ERPNext production database or shared Frappe DB user. A shared DB account resource limit would affect other ERP traffic, so it is not a safe shortcut. If isolation cannot be arranged, leave the gateway disabled; use reviewed fixed endpoints instead.
5. The script checks for a leading `creation` index, limits each query to 1-31 days, uses EXPLAIN to reject full scans/unindexed/over-100,000 estimated rows, and caps grouped results to 50. It deliberately refuses expensive queries rather than relaxing its limits.
6. Deploy the Cloudflare Worker from latest GitHub `main`. Open the ChatGPT plugin settings, choose **Always ask**, and refresh/reconnect the plugin to discover the two new tools.
7. **Approval:** `erp_prepare_read_query` is non-data preflight, `erp_run_read_query` requires an explicit user approval in chat. ChatGPT's **Always ask** app permission is the practical client enforcement. The server currently cannot cryptographically verify that a human approved a given query—do not treat the tool's description as a technical approval gate.

### Supported aggregates without another API
- Patient counts and breakdown by `territory` or `sex`.
- Lead counts grouped by `source`, `status`, or `territory`.
- Patient Appointment counts grouped by `status`, `practitioner`, or `department`.
- Patient Encounter counts grouped by `practitioner` or `company`.
- Clinical Procedure counts grouped by `practitioner`, `procedure_template`, or `status`.
- Sales Invoice counts and `SUM(base_grand_total)`, grouped by `docstatus` or `customer`.

Every request accepts a date range on `creation` (inclusive start, exclusive end), and at most one allowlisted equality filter. **No raw SQL, joins, cross-table subqueries, or System Console Python.** Complex analytics need additional reviewed schema-specific query patterns or a separate protected read-only replica service.

Example for today's Patient count:
```json
{
  "doctype": "Patient",
  "date_from": "2026-11-14",
  "date_to_exclusive": "2026-11-15",
  "metric": "count",
  "group_by": "",
  "filter_field": "",
  "filter_value": ""
}
```
This request will only succeed once the ERP Server Script, user permissions, creation index, MariaDB statement budget and MCP session connection are correct.

**Deployment status:** source pushed, not executed against production or end-to-end verified. If authentication succeeds but tools are not visible, confirm the ChatGPT app was refreshed and that its new tool list was discovered.


## Canonical OAuth redirect configuration

GitHub OAuth's upstream callback is **exactly** `https://mcp.erclens.com/callback`. It is not `/mcp`, `/authorize`, or the ChatGPT client callback. In the GitHub OAuth App settings, set **Authorization callback URL** to this precise HTTPS URL. Set the Homepage URL to `https://mcp.erclens.com`.

`wrangler.jsonc` now supplies `MCP_PUBLIC_ORIGIN=https://mcp.erclens.com`, and both the upstream authorization redirect and token exchange use the same canonical callback regardless of incoming Worker/proxy hostname. Do **not** put OAuth client secrets in `wrangler.jsonc`; keep `GITHUB_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY` in Cloudflare Secrets. `keep_vars` is enabled for deployment persistence.

The OAuth provider—not the GitHub OAuth App—handles the **ChatGPT redirect URI** registered through MCP client registration. Do not change GitHub's callback to ChatGPT's own redirect URI. The provider validates client redirect URIs and performs its final authorization redirect.

Checklist to diagnose errors after deployment:
- Verify the GitHub OAuth App callback above and the Client ID/Secret on the **same** app.
- Ensure the GitHub account is ID `10105528` and the Cloudflare Production `GITHUB_ALLOWED_USER_ID` is `10105528`.
- Check that `OAUTH_KV` is bound, the secret values exist in Production, and `/health` and OAuth metadata resolve.
- Inspect Cloudflare Worker logs for `/authorize` and `/callback` errors. Do not log or send OAuth authorization codes, tokens, secrets or cookies.
- Reconnect the existing ChatGPT MCP app after any OAuth client-registration changes.
- GitHub source changes are not proof of Cloudflare deployment or an end-to-end login.


## Unindexed one-day Patient count fallback (2026-11-14)

When `tabPatient.creation` has no leading index, the Worker now offers a **narrow,
fail-closed exception** for an exact one-day, ungrouped Patient `count` with
no extra filters. Normal indexed aggregate queries and list queries retain
their existing safety checks. No `ALTER TABLE` is performed.

**Two-stage setup:**
1. Review `erpnext/server_scripts/erp_mcp_daily_patient_count.py`; this is a
   separate fixed-purpose API Server Script, not a general SQL executor.
2. Set `ALLOWED_INTEGRATION_USER` to the **dedicated ERP API key user's email**
   inside the reviewed script. Do not allow Guest, and do not expose the API
   to unrelated users. The raw aggregate intentionally counts all Patient
   records, so this identity must be approved for cross-location totals.
3. Install as an ERPNext v14 Server Script: Type **API**, method
   `erp_mcp_daily_patient_count`, Allow Guest **unchecked**, enabled.
4. Verify in a non-production environment that Frappe safe_exec and your
   MariaDB 10.6 driver support `SET STATEMENT max_statement_time=2 FOR SELECT`.
   The timeout must be enforced by **MariaDB**, not by Cloudflare alone.
   If execution rejects this statement, leave the fallback disabled.
5. Use the MCP `erp_prepare_read_query` with date range spanning exactly one
   calendar day. Without an index, the preparer reports
   `requires_backend_setup: true` and `query_ready: false`: this does **not**
   claim that the ERP backend was deployed or tested.
6. After explicit user approval, `erp_run_read_query` calls only this
   dedicated endpoint for the exceptional case and verifies that the response
   contains the expected `bounded_fallback`, dates, metric, and integer total.

**Performance warning:** A one-day predicate without an index can still
read the entire ~697k-row Patient table. A 2-second database cap limits
statement duration, but does not guarantee the query will succeed. Prefer a
materialized daily summary or a carefully reviewed index for dependable
analytics. Do not expand this fallback to groupings, list reads, larger
date windows, or other DocTypes without a separate workload/security review.

**Deployment:** GitHub commits do not install ERPNext Server Scripts or
deploy Cloudflare automatically. Deploy and validate before using production.
