import type {Filter} from "./policy";

export interface TableProfile {
  doctype:string;
  approximate_rows:number;
  data_length:number;
  index_length:number;
  indexes:{index_name:string;columns:string[];non_unique:number}[];
}
export const MAX_ROWS=50;
export const LARGE_TABLE_ROWS=100000;
export const MAX_DATE_WINDOW_DAYS=31;
export function assertProfile(profile:TableProfile,doctype:string):void{
  if(!profile||profile.doctype!==doctype||!Number.isFinite(profile.approximate_rows)||profile.approximate_rows<0||
     !Array.isArray(profile.indexes)||profile.indexes.length===0)
    throw new Error("Missing or invalid live index/table profile. Refusing query");
}
function dateWindow(filters:Filter[],indexed:Set<string>):boolean{
  const candidates=["creation","modified","encounter_date","appointment_date","posting_date","start_date"];
  for(const field of candidates){
    if(!indexed.has(field))continue;
    const eq=filters.find(f=>f[0]===field&&f[1]==="=");
    if(eq&&typeof eq[2]==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(eq[2]))return true;
    const between=filters.find(f=>f[0]===field&&f[1]==="between"&&Array.isArray(f[2]));
    const lower=between?String((between[2] as unknown[])[0]):String(filters.find(f=>f[0]===field&&[">",">="].includes(f[1]))?.[2]??"");
    const upper=between?String((between[2] as unknown[])[1]):String(filters.find(f=>f[0]===field&&["<","<="].includes(f[1]))?.[2]??"");
    if(!/^\d{4}-\d{2}-\d{2}/.test(lower)||!/^\d{4}-\d{2}-\d{2}/.test(upper))continue;
    const l=Date.parse(lower.slice(0,10)+"T00:00:00Z"),u=Date.parse(upper.slice(0,10)+"T00:00:00Z");
    if(Number.isFinite(l)&&Number.isFinite(u)&&u>=l&&u-l<=MAX_DATE_WINDOW_DAYS*86400000)return true;
  }
  return false;
}
export function planQuery(profile:TableProfile,filters:Filter[],fields:string[],orderBy:string,offset:number,page:number) {
  assertProfile(profile,profile.doctype);
  if(page>MAX_ROWS||offset>1000)throw new Error("Page size or offset exceeds query safety budget; use indexed cursor filters instead");
  const leading=new Set(profile.indexes.filter(x=>Array.isArray(x.columns)&&x.columns.length&&
    x.columns.every(c=>typeof c==="string")).map(x=>x.columns[0]));
  if(!leading.size)throw new Error("No usable leading index");
  const indexedFilters=filters.filter(f=>leading.has(f[0])&&["=",">",">=","<","<=","in","between"].includes(f[1]));
  const orderField=orderBy.split(" ")[0];
  if(!leading.has(orderField))throw new Error("Sort field is not the leading column of an existing index");
  if(profile.approximate_rows>=LARGE_TABLE_ROWS){
    if(!indexedFilters.length)throw new Error("Large table: indexed filter is mandatory");
    if(!dateWindow(filters,leading))throw new Error("Large table: indexed date window <=31 days is mandatory");
    if(offset>200)throw new Error("Large table: deep offset pagination blocked");
  }else if(profile.approximate_rows>=10000&&!indexedFilters.length){
    throw new Error("Medium table: provide a leading-index filter");
  }
  return {approved:true,approximate_rows:profile.approximate_rows,leading_indexes:[...leading],filters,fields,page,offset};
}
