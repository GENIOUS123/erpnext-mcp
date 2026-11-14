# ERP ERC MCP Universal Read Query | Frappe / ERPNext v14
# API Server Script, API Method: erp_mcp_universal_read, Allow Guest: OFF.
# Install manually in ERPNext. Uses only parameterized SELECT statements.
# IMPORTANT: authenticated integration can see cross-record results. Use a
# dedicated least-privilege API account and MariaDB server-side timeout.
#
# POST form field "payload" contains JSON:
# {"mode":"schema","doctype":"Clinical Procedure"}
# {"mode":"query","query":{"base":"Clinical Procedure","alias":"cp",
#  "date_from":"2026-11-01","date_to_exclusive":"2026-11-15",
#  "fields":["cp.name","cp.status"],"filters":[{"field":"cp.docstatus","op":"=","value":0}],
#  "limit":50}}

approved = [
    "Clinical Procedure", "Sales Invoice", "Sales Invoice Item",
    "Sales Order", "Sales Order Item", "Patient", "Patient Encounter",
    "Patient Appointment", "Healthcare Practitioner", "Healthcare Service Unit",
    "Customer", "Camp", "Lead", "Pre Camp", "Appointment Request"
]

# The Worker posts {"payload": {...}} as application/json.
# Frappe v14 places the structured value directly in frappe.form_dict.
# Avoid frappe.parse_json: it is not exposed in some safe_exec environments.
request = frappe.form_dict.get("payload")
if not isinstance(request, dict):
    frappe.throw("Expected structured JSON payload object")
if len(str(request)) > 12000:
    frappe.throw("Oversized payload")

mode = request.get("mode")
if mode not in ["schema", "query"]:
    frappe.throw("Mode must be schema or query")

def columns_for(doctype):
    if doctype not in approved:
        frappe.throw("DocType is not approved: " + str(doctype))
    rows = frappe.db.sql(
        """SELECT COLUMN_NAME AS field
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
           ORDER BY ORDINAL_POSITION LIMIT 250""",
        ("tab" + doctype,), as_dict=True
    )
    if not rows:
        frappe.throw("DocType table not found: " + doctype)
    return [r["field"] for r in rows]

def valid_alias(alias):
    if not isinstance(alias, str) or len(alias) < 1 or len(alias) > 16:
        frappe.throw("Invalid alias")
    if not alias[0].isalpha() or not alias.replace("_", "").isalnum():
        frappe.throw("Alias must contain only letters, numbers, underscore")
    return alias

if mode == "schema":
    doctype = request.get("doctype")
    fields = columns_for(doctype)
    links = frappe.db.sql(
        """SELECT fieldname, options AS target, fieldtype
           FROM `tabDocField`
           WHERE parent = %s AND fieldtype IN ('Link','Dynamic Link')
           UNION ALL
           SELECT fieldname, options AS target, fieldtype
           FROM `tabCustom Field`
           WHERE dt = %s AND fieldtype IN ('Link','Dynamic Link')
           LIMIT 150""",
        (doctype, doctype), as_dict=True
    )
    frappe.response["message"] = {
        "success": True, "mode": "schema", "doctype": doctype,
        "columns": fields, "link_fields": links
    }
else:
    query = request.get("query") or {}
    if not isinstance(query, dict):
        frappe.throw("query must be an object")
    base = query.get("base")
    base_alias = valid_alias(query.get("alias") or "t")
    catalog = {base_alias: {"doctype": base, "columns": columns_for(base)}}

    date_from = str(query.get("date_from") or "")
    date_to = str(query.get("date_to_exclusive") or "")
    if len(date_from) != 10 or len(date_to) != 10:
        frappe.throw("Date range YYYY-MM-DD is required")
    try:
        start = frappe.utils.getdate(date_from)
        end = frappe.utils.getdate(date_to)
    except Exception:
        frappe.throw("Invalid date")
    span = (end - start).days
    if span < 1 or span > 31:
        frappe.throw("Date range must be 1 through 31 days")
    if "creation" not in catalog[base_alias]["columns"]:
        frappe.throw("Base DocType must have creation column")

    def field_sql(path, known):
        if not isinstance(path, str) or path.count(".") != 1:
            frappe.throw("Use alias.column for every field")
        parts = path.split(".")
        a = parts[0]
        f = parts[1]
        if a not in known or f not in known[a]["columns"]:
            frappe.throw("Unknown/unauthorized field: " + str(path))
        return "`" + a + "`.`" + f + "`"

    joins = query.get("joins") or []
    if not isinstance(joins, list) or len(joins) > 3:
        frappe.throw("Maximum three joins")
    join_sql = ""
    for join in joins:
        if not isinstance(join, dict):
            frappe.throw("Invalid join")
        jd = join.get("doctype")
        ja = valid_alias(join.get("alias"))
        kind = join.get("type") or "left"
        if ja in catalog or kind not in ["left", "inner"]:
            frappe.throw("Invalid or duplicate join alias/type")
        new_columns = columns_for(jd)
        left = field_sql(join.get("left"), catalog)
        future = dict(catalog)
        future[ja] = {"doctype": jd, "columns": new_columns}
        right_path = join.get("right")
        if not isinstance(right_path, str) or not right_path.startswith(ja + "."):
            frappe.throw("Right join field must refer to the new alias")
        right = field_sql(right_path, future)
        join_sql = join_sql + " " + kind.upper() + " JOIN `tab" + jd + "` AS `" + ja + "` ON " + left + " = " + right
        catalog = future

    fields = query.get("fields") or []
    groups = query.get("group_by") or []
    metrics = query.get("metrics") or []
    filters = query.get("filters") or []
    orders = query.get("order_by") or []
    if (not isinstance(fields, list) or len(fields) > 20 or
        not isinstance(groups, list) or len(groups) > 6 or
        not isinstance(metrics, list) or len(metrics) > 5 or
        not isinstance(filters, list) or len(filters) > 12 or
        not isinstance(orders, list) or len(orders) > 3):
        frappe.throw("Query exceeds bounded field/condition limits")

    if metrics:
        if fields and (not groups or any(x not in groups for x in fields)):
            frappe.throw("Selected fields must appear in group_by when aggregating")
    elif groups:
        frappe.throw("group_by requires metrics")

    selections = []
    for path in fields:
        selections.append(field_sql(path, catalog) + " AS `" + path.replace(".", "_") + "`")

    metric_aliases = []
    for m in metrics:
        if not isinstance(m, dict):
            frappe.throw("Invalid metric")
        fn = m.get("fn")
        alias = valid_alias(m.get("as") or "total")
        if alias in metric_aliases:
            frappe.throw("Duplicate metric alias")
        metric_aliases.append(alias)
        if fn == "count":
            expr = "COUNT(*)"
        elif fn in ["count_distinct", "sum", "min", "max", "avg"]:
            col = field_sql(m.get("field"), catalog)
            if fn == "count_distinct":
                expr = "COUNT(DISTINCT " + col + ")"
            else:
                expr = fn.upper() + "(" + col + ")"
        else:
            frappe.throw("Unsupported aggregate function")
        selections.append(expr + " AS `" + alias + "`")
    if not selections:
        frappe.throw("Select fields or metrics required")

    where = ["`" + base_alias + "`.`creation` >= %s", "`" + base_alias + "`.`creation` < %s"]
    values = [date_from + " 00:00:00", date_to + " 00:00:00"]
    for f in filters:
        if not isinstance(f, dict):
            frappe.throw("Invalid filter")
        col = field_sql(f.get("field"), catalog)
        op = f.get("op") or "="
        if op in ["is_null", "is_not_null"]:
            where.append(col + (" IS NULL" if op == "is_null" else " IS NOT NULL"))
        elif op == "in":
            vs = f.get("value")
            if not isinstance(vs, list) or not vs or len(vs) > 30:
                frappe.throw("IN requires 1 to 30 values")
            if any(isinstance(v, (list, dict)) for v in vs):
                frappe.throw("Invalid IN values")
            where.append(col + " IN (" + ",".join(["%s"] * len(vs)) + ")")
            values.extend(vs)
        elif op in ["=", "!=", ">", ">=", "<", "<=", "like"]:
            value = f.get("value")
            if value is None or isinstance(value, (list, dict)):
                frappe.throw("Invalid filter value")
            if isinstance(value, str) and len(value) > 250:
                frappe.throw("Filter value too long")
            where.append(col + " " + ("LIKE" if op == "like" else op) + " %s")
            values.append(value)
        else:
            frappe.throw("Unsupported filter operator")

    group_sql = ""
    if groups:
        group_sql = " GROUP BY " + ", ".join([field_sql(x, catalog) for x in groups])

    order_sql = ""
    if orders:
        order_parts = []
        for o in orders:
            if not isinstance(o, dict):
                frappe.throw("Invalid order")
            direction = str(o.get("direction") or "asc").lower()
            if direction not in ["asc", "desc"]:
                frappe.throw("Invalid sort direction")
            name = o.get("field")
            if name in metric_aliases:
                sort_expr = "`" + name + "`"
            else:
                sort_expr = field_sql(name, catalog)
            order_parts.append(sort_expr + " " + direction.upper())
        order_sql = " ORDER BY " + ", ".join(order_parts)

    try:
        limit = int(query.get("limit") or 50)
        offset = int(query.get("offset") or 0)
    except Exception:
        frappe.throw("Invalid pagination values")
    if limit < 1 or limit > 100 or offset < 0 or offset > 1000:
        frappe.throw("limit 1-100 and offset 0-1000 required")

    sql = (
        "SELECT " + ", ".join(selections) +
        " FROM `tab" + base + "` AS `" + base_alias + "`" +
        join_sql + " WHERE " + " AND ".join(where) +
        group_sql + order_sql + " LIMIT %s OFFSET %s"
    )
    values.extend([limit, offset])
    rows = frappe.db.sql(sql, tuple(values), as_dict=True)
    frappe.response["message"] = {
        "success": True, "read_only": True, "mode": "query",
        "base": base, "date_from": date_from,
        "date_to_exclusive": date_to, "count_returned": len(rows),
        "limit": limit, "offset": offset, "data": rows
    }
