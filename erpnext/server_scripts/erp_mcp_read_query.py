# ERPNext / Frappe v14 | Manually installed API Server Script
# API Method: erp_mcp_read_query | Allow Guest: unchecked
# Fixed, allowlisted SELECT-only aggregate gateway. No arbitrary SQL or Python.
# For production use, require a dedicated read-only integration identity and
# a MariaDB-enforced statement timeout for that identity / connection.
#
# Request fields: doctype, date_from, date_to (exclusive), metric, group_by,
# filter_field, filter_value.
# IMPORTANT: This script bypasses row-level record permission filtering.
# Only use for trusted users explicitly allowed to see aggregates across a DocType.

allowed = {
    "Patient": {"groups": ["territory", "sex"], "filters": ["territory", "sex"], "sums": []},
    "Lead": {"groups": ["source", "status", "territory"], "filters": ["source", "status", "territory"], "sums": []},
    "Patient Appointment": {"groups": ["status", "practitioner", "department"], "filters": ["status", "practitioner", "department"], "sums": []},
    "Patient Encounter": {"groups": ["practitioner", "company"], "filters": ["practitioner", "company"], "sums": []},
    "Clinical Procedure": {"groups": ["practitioner", "procedure_template", "status"], "filters": ["practitioner", "procedure_template", "status"], "sums": []},
    "Sales Invoice": {"groups": ["docstatus", "customer"], "filters": ["docstatus", "customer"], "sums": ["base_grand_total"]}
}

dt = str(frappe.form_dict.get("doctype") or "").strip()
if dt not in allowed:
    frappe.throw("This DocType is not approved for MCP analytics")

if not frappe.has_permission(dt, "read"):
    frappe.throw("MCP account lacks Read permission on this DocType")

date_from = str(frappe.form_dict.get("date_from") or "").strip()
date_to = str(frappe.form_dict.get("date_to") or "").strip()
metric = str(frappe.form_dict.get("metric") or "count").strip()
group_by = str(frappe.form_dict.get("group_by") or "").strip()
filter_field = str(frappe.form_dict.get("filter_field") or "").strip()
filter_value = str(frappe.form_dict.get("filter_value") or "").strip()

if len(date_from) != 10 or len(date_to) != 10:
    frappe.throw("Dates must be YYYY-MM-DD")
if date_from[4:5] != "-" or date_from[7:8] != "-" or date_to[4:5] != "-" or date_to[7:8] != "-":
    frappe.throw("Invalid date format")
try:
    start_date = frappe.utils.getdate(date_from)
    end_date = frappe.utils.getdate(date_to)
except Exception:
    frappe.throw("Invalid date")
days = (end_date - start_date).days
if days < 1 or days > 31:
    frappe.throw("Date range must be 1 to 31 days, exclusive end")

rule = allowed[dt]
if group_by and group_by not in rule["groups"]:
    frappe.throw("Grouping field not approved")
if filter_field and filter_field not in rule["filters"]:
    frappe.throw("Filter field not approved")
if filter_field and (not filter_value or len(filter_value) > 100):
    frappe.throw("Filter value missing or too long")
if filter_value and not filter_field:
    frappe.throw("Filter field is required")
if metric != "count" and metric != "sum_base_grand_total":
    frappe.throw("Metric not supported")
if metric == "sum_base_grand_total" and "base_grand_total" not in rule["sums"]:
    frappe.throw("SUM is not approved for this DocType")
if dt == "Sales Invoice" and filter_field == "docstatus" and filter_value not in ["0", "1", "2"]:
    frappe.throw("Invalid docstatus")

table_name = "tab" + dt
# Index metadata is a low-cost information_schema query, not a table scan.
index_rows = frappe.db.sql(
    """SELECT INDEX_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = %s AND COLUMN_NAME = 'creation'
         AND SEQ_IN_INDEX = 1
       LIMIT 1""",
    (table_name,), as_dict=True
)
if not index_rows:
    frappe.throw("REFUSED: creation is not a leading column of any index")

approx = frappe.db.sql(
    """SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
       LIMIT 1""",
    (table_name,), as_dict=True
)
if not approx:
    frappe.throw("REFUSED: table size metadata unavailable")

# Identifiers originate exclusively from the hardcoded allowlist, never user SQL.
table_sql = "`" + table_name + "`"
where_sql = " WHERE `creation` >= %s AND `creation` < %s"
values = [date_from + " 00:00:00", date_to + " 00:00:00"]
if filter_field:
    where_sql = where_sql + " AND `" + filter_field + "` = %s"
    values.append(filter_value)
measure = "COUNT(*) AS total"
if metric == "sum_base_grand_total":
    measure = "COALESCE(SUM(`base_grand_total`),0) AS total"
group_sql = ""
if group_by:
    measure = "`" + group_by + "` AS dimension, " + measure
    group_sql = " GROUP BY `" + group_by + "` ORDER BY total DESC LIMIT 50"

statement = "SELECT " + measure + " FROM " + table_sql + where_sql + group_sql
# Validate the actual optimizer plan before executing the aggregate.
plan = frappe.db.sql("EXPLAIN " + statement, tuple(values), as_dict=True)
if not plan:
    frappe.throw("REFUSED: EXPLAIN returned no plan")
for line in plan:
    access_type = str(line.get("type") or "").upper()
    used_key = line.get("key")
    estimated = int(line.get("rows") or 0)
    if access_type == "ALL" or not used_key or estimated > 100000:
        frappe.throw("REFUSED: unsafe EXPLAIN plan; consider an index or narrower date range")

# NOTE: the HTTP timeout cannot kill a running SQL query. Require an
# independent server-side max_statement_time policy prior to production use.
result = frappe.db.sql(statement, tuple(values), as_dict=True)
frappe.response["message"] = {
    "doctype": dt,
    "metric": metric,
    "group_by": group_by or None,
    "date_from": date_from,
    "date_to_exclusive": date_to,
    "approximate_table_rows": int(approx[0].get("TABLE_ROWS") or 0),
    "index": index_rows[0].get("INDEX_NAME"),
    "explain": [
        {"key": item.get("key"), "type": item.get("type"),
         "rows": item.get("rows")} for item in plan
    ],
    "data": result
}
