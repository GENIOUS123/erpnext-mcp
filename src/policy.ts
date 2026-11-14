// Central allowlist. Only explicitly listed fields are readable; adding a field requires a code review.
// Names are ERPNext v14 defaults or documented custom DocTypes; confirm locally before adding more.
export const FIELDS: Record<string, readonly string[]> = {
  "Patient": ["name", "creation", "modified", "sex", "dob", "territory"],
  "Patient Encounter": ["name", "creation", "modified", "patient", "practitioner", "appointment", "encounter_date", "encounter_time", "company"],
  "Patient Appointment": ["name", "creation", "modified", "patient", "practitioner", "appointment_date", "appointment_time", "status", "department", "company"],
  "Healthcare Practitioner": ["name", "creation", "modified", "practitioner_name", "department", "status"],
  "Clinical Procedure": ["name", "creation", "modified", "patient", "practitioner", "procedure_template", "start_date", "status", "company"],
  "Lead": ["name", "creation", "modified", "status", "source", "territory"],
  "Appointment Request": ["name", "creation", "modified"],
  "Pre Camp": ["name", "creation", "modified", "status", "territory"],
  "Camp": ["name", "creation", "modified", "territory"],
  "Sales Invoice": ["name", "creation", "modified", "posting_date", "base_grand_total", "docstatus", "customer", "is_return"]
};
export const FILTER_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "in", "not in", "like", "between"] as const;
export function fieldsFor(doctype: string): readonly string[] {
  const fields = FIELDS[doctype];
  if (!fields) throw new Error("DocType is not allowlisted");
  return fields;
}
export function assertFields(doctype: string, requested: string[]): string[] {
  const allowed = fieldsFor(doctype);
  if (requested.length === 0 || requested.length > 24) throw new Error("Provide 1-24 fields");
  if (requested.some(f => !allowed.includes(f))) throw new Error("A requested field is not allowlisted");
  return [...new Set(requested)];
}
export function validateFilters(doctype: string, filters: unknown[][]): unknown[][] {
  const allowed = fieldsFor(doctype);
  if (filters.length > 12) throw new Error("Too many filters");
  return filters.map(f => {
    if (!Array.isArray(f) || f.length !== 3 || typeof f[0] !== "string" || !allowed.includes(f[0])) throw new Error("Invalid filter field");
    if (typeof f[1] !== "string" || !FILTER_OPERATORS.includes(f[1] as typeof FILTER_OPERATORS[number])) throw new Error("Invalid filter operator");
    const value = f[2];
    if (value === null || typeof value === "object" && !Array.isArray(value)) throw new Error("Invalid filter value");
    if (Array.isArray(value) && (value.length > 100 || value.some(v => !["string","number","boolean"].includes(typeof v)))) throw new Error("Invalid filter list");
    if (typeof value === "string" && value.length > 200) throw new Error("Filter too long");
    return f;
  });
}
