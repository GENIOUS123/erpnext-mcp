# ERP MCP Universal Read Query

This feature adds the structured `erp_universal_read` MCP tool. It is intentionally **not** an arbitrary SQL executor. ERPNext validates table names and column names against a restricted DocType allowlist and live database metadata. All SQL values use bound parameters; the generated statement is always a `SELECT`.

## Installation

1. In ERPNext v14, create an **API Server Script** with API Method `erp_mcp_universal_read`, Allow Guest **unchecked**. Paste the entire contents of [erp_mcp_universal_read.py](./erpnext/server_scripts/erp_mcp_universal_read.py).
2. Save and enable the Server Script, and ensure the authorized integration identity can invoke the endpoint.
3. Deploy the Cloudflare Worker from the same `main` branch (`npm run deploy` with the configured Wrangler environment). No new OAuth secrets are required.
4. Refresh/reconnect the ChatGPT MCP plugin so the newly registered `erp_universal_read` tool is discovered.
5. Test **schema** mode first; then request explicit approval before running a live **query**.

Important: The GitHub commit does not update the existing ERPNext Server Script or deploy Cloudflare automatically.

## Tool inputs

```json
{"mode":"schema","doctype":"Clinical Procedure"}
```

Schema mode returns actual table columns plus built-in and custom Link fields. Run this for Clinical Procedure, Sales Invoice and Sales Invoice Item before choosing join keys. An invoice associated with the same patient is **not necessarily linked to the procedure**.

```json
{
  "mode":"query",
  "query":{
    "base":"Clinical Procedure",
    "alias":"cp",
    "date_from":"2026-11-01",
    "date_to_exclusive":"2026-11-15",
    "fields":["cp.name","cp.creation","cp.status","cp.docstatus"],
    "filters":[{"field":"cp.docstatus","op":"=","value":0}],
    "order_by":[{"field":"cp.creation","direction":"desc"}],
    "limit":50,
    "offset":0
  }
}
```

Example grouped summary:

```json
{
  "mode":"query",
  "query":{
    "base":"Clinical Procedure",
    "alias":"cp",
    "date_from":"2026-10-01",
    "date_to_exclusive":"2026-11-01",
    "fields":["cp.docstatus"],
    "group_by":["cp.docstatus"],
    "metrics":[{"fn":"count","as":"total"}],
    "order_by":[{"field":"total","direction":"desc"}]
  }
}
```

### Join example (adapt link field from schema discovery)

```json
{
  "mode":"query",
  "query":{
    "base":"Clinical Procedure",
    "alias":"cp",
    "date_from":"2026-11-01",
    "date_to_exclusive":"2026-11-15",
    "fields":["cp.name","cp.docstatus","si.name","si.docstatus"],
    "joins":[
      {"doctype":"Sales Invoice Item","alias":"sii","type":"left",
       "left":"cp.name","right":"sii.custom_clinical_procedure"},
      {"doctype":"Sales Invoice","alias":"si","type":"left",
       "left":"sii.parent","right":"si.name"}
    ],
    "filters":[{"field":"cp.docstatus","op":"=","value":0}],
    "limit":50
  }
}
```

`sii.custom_clinical_procedure` is **only an illustrative placeholder**. The real link may be a custom field on Clinical Procedure, invoice, invoice item, Sales Order, or another intermediary DocType. Discover and verify actual relation fields before querying. Filter Siliguri using the verified hospital/service unit field.

## Limits / safeguards

- Approved DocTypes only; live columns must exist.
- Date window bound to the **base DocType's creation** column, 1 to 31 days.
- Up to 3 joins; 12 conditions; 20 selected fields; 5 aggregates.
- `count`, `count_distinct`, `sum`, `min`, `max`, `avg`.
- `=`, `!=`, inequalities, `like`, `in`, `is_null`, `is_not_null`.
- Up to 100 result rows/request; max offset 1000. Aggregations can still scan more source rows.
- No forced index check, no raw SQL, no updates/deletes/DDL.
- **Deploy with least-privilege credentials and a MariaDB-enforced query timeout.** HTTP timeouts do not necessarily cancel server-side SQL. API Server Scripts using direct `frappe.db.sql` do not apply Frappe's per-row permission filters, so the authorized integration identity must be highly restricted. Do not expose as a guest endpoint.
- Live data runs require explicit user approval; schema introspection does not return patient records.

## Troubleshooting

If the Cloudflare tool is absent, redeploy and refresh the MCP connection. If the ERP endpoint returns HTTP 404, install the new API Server Script. For HTTP 500, inspect the ERPNext Error Log; the most likely issues are missing `frappe.parse_json` in the Server Script sandbox, table/field mismatches, or database permissions. Tests must verify actual ERPNext v14 safe_exec availability in the target instance.
