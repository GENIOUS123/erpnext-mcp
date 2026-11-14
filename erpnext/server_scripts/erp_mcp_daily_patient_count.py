# ERPNext v14 / MariaDB 10.6 - manually installed API Server Script
# API Method: erp_mcp_daily_patient_count | Allow Guest: unchecked
# Read-only, fixed one-day Patient creation COUNT. No arbitrary SQL.
#
# IMPORTANT: Before installation, change the explicit integration user below.
# The API returns ALL-Patient aggregate totals (raw SQL does not apply
# Frappe record-level permissions). Grant access only to a dedicated trusted
# ERP integration identity permitted to view that organization-wide total.
#
# The per-statement MariaDB timeout is mandatory. If your safe_exec / DB
# wrapper does not support SET STATEMENT, leave the endpoint disabled.
# Do not replace with an unbounded SELECT or a Cloudflare-only timeout.

ALLOWED_INTEGRATION_USER = "SET_YOUR_DEDICATED_ERP_USER_EMAIL"

current_user = str(frappe.session.user or "").strip()
if (not ALLOWED_INTEGRATION_USER
        or ALLOWED_INTEGRATION_USER == "SET_YOUR_DEDICATED_ERP_USER_EMAIL"
        or current_user != ALLOWED_INTEGRATION_USER):
    frappe.throw("MCP daily count integration identity not configured or unauthorized")

# Permission-aware probe. This does not authorize row-level-scoped
# aggregates; the explicitly whitelisted identity must be approved for
# organization-wide Patient counts.
frappe.get_list("Patient", fields=["name"], limit_page_length=1)

date_from = str(frappe.form_dict.get("date_from") or "").strip()
date_to = str(frappe.form_dict.get("date_to_exclusive") or "").strip()

if (len(date_from) != 10 or len(date_to) != 10
        or date_from[4:5] != "-" or date_from[7:8] != "-"
        or date_to[4:5] != "-" or date_to[7:8] != "-"):
    frappe.throw("Dates must be YYYY-MM-DD")

try:
    start_date = frappe.utils.getdate(date_from)
    end_date = frappe.utils.getdate(date_to)
except Exception:
    frappe.throw("Invalid dates")

if (str(start_date) != date_from
        or str(end_date) != date_to
        or (end_date - start_date).days != 1):
    frappe.throw("Only exactly one calendar day is allowed")

# MariaDB 10.6 SET STATEMENT applies max_statement_time to this
# statement only (2 seconds), avoiding changes to the shared DB session.
# It is a fixed SQL statement with parameterized bounds and no user-supplied
# identifiers. A missing index can still require a large scan; the query
# must time out rather than occupy production DB indefinitely.
result = frappe.db.sql(
    """
    SET STATEMENT max_statement_time=2 FOR
    SELECT COUNT(*) AS total
    FROM `tabPatient`
    WHERE `creation` >= %s
      AND `creation` < %s
    """,
    (date_from + " 00:00:00", date_to + " 00:00:00"),
    as_dict=True
)
if not result:
    frappe.throw("Count result unavailable")

frappe.response["message"] = {
    "bounded_fallback": True,
    "doctype": "Patient",
    "metric": "count",
    "date_from": date_from,
    "date_to_exclusive": date_to,
    "total": int(result[0].get("total") or 0),
    "statement_timeout_seconds": 2,
    "note": "Site-local creation date, fixed aggregate; no patient records returned"
}
