# ERPNext v14 — Read-only MCP

This is an initial remote MCP gateway for ERPNext/Frappe v14, hosted on Cloudflare Workers, designed for questions such as doctor detection counts, lead funnels and camp analysis. **Source code has been pushed; no deployment, credentials or ERP connection has been configured.**

## First-stage MCP tools
- `erp_capabilities`: supported DocTypes and allowed fields
- `erp_list_records`: parameterized Frappe GET /api/resource, allowlisted field selection, filters, pagination
- `erp_count_records`: bounded count (paginates at most 10,000 rows; intended for small data, not production-size aggregates)

There are no tools for mutation, executing System Console Python, running arbitrary SQL or arbitrary ERP API methods. GET-only calls and restricted ERP account permissions are both mandatory.

## How to configure

1. In ERPNext, create a dedicated integration user with a custom **Read-only** role. Grant only Read on required DocTypes. Do **not** grant System Manager, Write, Create, Delete, Submit, Cancel, Import, Export or broad access to Patient records.
2. Create API Key and API Secret for this identity in ERPNext.
3. Review `src/policy.ts`. Check actual fieldnames against the v14 installation (custom DocTypes and fields may differ). Never add phone, email, address, DOB or other sensitive patient fields without explicit authorization. DOB appears in the initial allowlist and **should be removed if it is not required**.
4. On a developer machine: `npm install`, `npm run check` and `npm run dev`. Do not treat the repository as tested until these pass.
5. Set Cloudflare Worker secrets with `npx wrangler secret put <NAME>` for:
   - `ERP_BASE_URL` — `https://erp.erchms.com`
   - `ERP_API_KEY`
   - `ERP_API_SECRET`
   - `MCP_ACCESS_TOKEN` — a unique long random bearer token
6. Deploy with `npm run deploy`. Endpoint is `https://<your-worker>.workers.dev/mcp`; `/health` shows non-sensitive service status.
7. Test with an authenticated Streamable HTTP MCP client / MCP Inspector. The MCP caller sends `Authorization: Bearer <MCP_ACCESS_TOKEN>`. Check read tools and confirm write attempts are impossible.
8. To connect inside ChatGPT, use a workspace/plan with custom MCP capability. Check current eligibility. **Publishing to GitHub does not connect this chat.** For production ChatGPT compatibility, replace static bearer auth with a standards-compliant OAuth flow.

## Developing new questions / reports

For new questions that need complex joins and aggregates, write and review narrowly scoped read-only Frappe API Server Scripts (or dedicated methods in a separately deployed custom app), and install them **manually** on ERPNext. The MCP can then expose a specifically approved tool for each report. Do not add a general-purpose System Console executor or generic SQL-execution endpoint.

## Safeguards / limits

- Allowlisted DocTypes and fields only (`src/policy.ts`)
- No arbitrary Python, SQL or mutation API
- ERP API user should be restricted with ERP role permissions
- Upstream timeout 12 seconds, response max 250KB, page max 100
- Query filters validated and bounded
- Secrets stored in Cloudflare, not this public GitHub repository

## Version target

Frappe 14.78.1, ERPNext 14.70.12, Healthcare 14.0.3, HRMS 14.29.1 and MariaDB 10.6.x.

## Status

**Pre-deployment source code only.** The repository has not been live-tested against ERPNext; setup and security review are required.