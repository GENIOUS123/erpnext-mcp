# ERPNext v14 | Server Script: API | API Method: erp_mcp_count_patients
# Allow Guest: unchecked. Manually install. Strictly read-only.
# This is NOT arbitrary SQL execution. Only counts Patient creations within <=31 days.
# Production recommendation: configure a MariaDB server-side statement time limit
# for this integration user, as HTTP cancellation does NOT stop a running SQL query.

if not frappe.has_permission("Patient", "read"):
    frappe.throw("Patient read permission required")

date_from = str(frappe.form_dict.get("date_from") or "").strip()
date_to = str(frappe.form_dict.get("date_to") or "").strip()

# Inclusive start and exclusive end, using site-local ERPNext dates.
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
    frappe.throw("Date range must be 1 to 31 days (exclusive end)")

# Inspect the existing indexes BEFORE allowing any COUNT against tabPatient.
indexes = frappe.db.sql(
    """SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
         AND SEQ_IN_INDEX = 1 AND COLUMN_NAME = %s
       LIMIT 1""",
    ("tabPatient", "creation"), as_dict=True
)
if not indexes:
    frappe.throw("BLOCKED: Patient.creation has no leading-column index. Ask administrator to review indexing; no count was executed.")

start_ts = date_from + " 00:00:00"
end_ts = date_to + " 00:00:00"
rows = frappe.db.sql(
    """SELECT COUNT(*) AS total
       FROM `tabPatient`
       WHERE creation >= %s AND creation < %s""",
    (start_ts, end_ts), as_dict=True
)
frappe.response["message"] = {
    "doctype": "Patient",
    "metric": "created_count",
    "date_from": date_from,
    "date_to_exclusive": date_to,
    "timezone": "ERPNext site's configured timezone",
    "index": indexes[0].get("INDEX_NAME"),
    "count": int(rows[0].get("total") or 0)
}
