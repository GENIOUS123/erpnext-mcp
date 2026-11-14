# ERPNext v14 API Server Script
# Script Type: API | API Method: erp_mcp_table_profile | Allow Guest: NO
# READ ONLY. No writes, migrations, DDL or unbounded table scans.
# Install manually after review. Its output is metadata only.
allowed = [
  "Patient", "Patient Encounter", "Patient Appointment",
  "Healthcare Practitioner", "Clinical Procedure", "Lead",
  "Appointment Request", "Pre Camp", "Camp", "Sales Invoice"
]
dt = str(frappe.form_dict.get("doctype") or "").strip()
if dt not in allowed:
    frappe.throw("DocType not approved for MCP metadata")
# Parameterized access to information_schema: no dynamic table SQL.
table_name = "tab" + dt
table_rows = frappe.db.sql(
    """SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
       LIMIT 1""", (table_name,), as_dict=True
)
if not table_rows:
    frappe.throw("Table metadata unavailable")
raw_indexes = frappe.db.sql(
    """SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
       ORDER BY INDEX_NAME, SEQ_IN_INDEX""", (table_name,), as_dict=True
)
indexes = {}
for item in raw_indexes:
    key = str(item.get("INDEX_NAME") or "")
    if key not in indexes:
        indexes[key] = {
            "index_name": key, "columns": [],
            "non_unique": int(item.get("NON_UNIQUE") or 0)
        }
    indexes[key]["columns"].append(str(item.get("COLUMN_NAME") or ""))
frappe.response["message"] = {
    "doctype": dt,
    "approximate_rows": int(table_rows[0].get("TABLE_ROWS") or 0),
    "data_length": int(table_rows[0].get("DATA_LENGTH") or 0),
    "index_length": int(table_rows[0].get("INDEX_LENGTH") or 0),
    "indexes": list(indexes.values()),
    "note": "InnoDB TABLE_ROWS is approximate; this metadata query does not scan data."
}
