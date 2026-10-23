import copy from "../../content/ui-copy.json" with { type: "json" };

/** All values are plain text; render them through textContent, never innerHTML. */
export const UI_COPY: Readonly<Record<string,string>> = Object.freeze({...copy.strings});
export type UiParameters = Readonly<Record<string,string|number>>;

/** Missing copy and substitutions are authoring errors, never visible implementation keys. */
export function uiText(key:string, parameters:UiParameters={}):string {
  const text=UI_COPY[key];
  if(text===undefined) throw new Error(`Unknown UI copy key: ${key}`);
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(_match,name:string)=>{
    const value=parameters[name];
    if(value===undefined || typeof value==="number" && !Number.isFinite(value)) throw new Error(`Missing UI copy parameter: ${key}/${name}`);
    return String(value);
  });
}
