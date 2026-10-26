import type { UiCopy } from "./types.ts";

/** Content owns all player-visible strings; substitution never introduces HTML. */
export function copyFromCatalog(catalog:Readonly<Record<string,string>>):UiCopy {
  return (key,values={})=>{
    const template=catalog[key];
    if(template===undefined)throw new Error(`Missing UI content key: ${key}`);
    return template.replace(/\{([A-Za-z0-9_]+)\}/g,(_match,name:string)=>String(values[name]??`{${name}}`));
  };
}

export function formatMoney(cents:number):string {
  const safe=Number.isFinite(cents)?Math.max(0,Math.round(cents)):0;
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(safe/100);
}
export function bounded(value:number,min:number,max:number):number {return Number.isFinite(value)?Math.max(min,Math.min(max,value)):min;}
