// Whitelisted fields and operators. Production tables need a fresh metadata profile
// before any read is executed; see src/query-guard.ts.
export const FIELDS: Record<string, readonly string[]> = {
  "Patient": ["name","creation","modified","sex","territory"],
  "Patient Encounter": ["name","creation","modified","patient","practitioner","appointment","encounter_date","encounter_time","company"],
  "Patient Appointment": ["name","creation","modified","patient","practitioner","appointment_date","appointment_time","status","department","company"],
  "Healthcare Practitioner": ["name","creation","modified","practitioner_name","department","status"],
  "Clinical Procedure": ["name","creation","modified","patient","practitioner","procedure_template","start_date","status","company"],
  "Lead": ["name","creation","modified","status","source","territory"],
  "Appointment Request": ["name","creation","modified"],
  "Pre Camp": ["name","creation","modified","status","territory"],
  "Camp": ["name","creation","modified","territory"],
  "Sales Invoice": ["name","creation","modified","posting_date","base_grand_total","docstatus","customer","is_return"]
};
export const FILTER_OPERATORS = ["=",">",">=","<","<=","in","between"] as const;
export function fieldsFor(doctype:string):readonly string[]{
  const f=FIELDS[doctype];if(!f) throw new Error("DocType not allowlisted");return f;
}
export function assertFields(doctype:string, fields:string[]):string[]{
  const allowed=fieldsFor(doctype);
  if(!fields.length||fields.length>16||fields.some(f=>!allowed.includes(f)))throw new Error("Fields not allowlisted");
  return [...new Set(fields)];
}
export type Filter=[string,string,string|number|boolean|(string|number|boolean)[]];
export function validateFilters(doctype:string,filters:Filter[]):Filter[]{
  const allowed=fieldsFor(doctype);
  if(filters.length>8)throw new Error("Too many filters");
  for(const f of filters){
    if(!Array.isArray(f)||f.length!==3||!allowed.includes(f[0])||!FILTER_OPERATORS.includes(f[1] as typeof FILTER_OPERATORS[number]))
      throw new Error("Disallowed field/operator");
    if(Array.isArray(f[2])){
      if(!["in","between"].includes(f[1]))throw new Error("Array only for in/between");
      if(f[2].length>(f[1]==="between"?2:30)||f[2].length<1)throw new Error("Invalid filter array");
      if(f[2].some(v=>typeof v==="string"&&v.length>120))throw new Error("Value too long");
    } else if(f[1]==="between"||f[1]==="in"||typeof f[2]==="string"&&f[2].length>120)
      throw new Error("Invalid filter value");
  }
  return filters;
}
