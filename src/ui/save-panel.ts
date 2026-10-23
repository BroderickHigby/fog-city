import type { ProgressionDocument, SaveSlot, SaveStore } from "../save/store.ts";
import type { UiCopy } from "./types.ts";

export interface SavePanelOptions {
  readonly store:SaveStore;
  readonly capture:()=>ProgressionDocument;
  /** Host restores validated progression into a fresh, threat-free spawn. */
  readonly restore:(data:ProgressionDocument)=>void|Promise<void>;
}
export function mountSavePanel(doc:Document,copy:UiCopy,options:SavePanelOptions):{element:HTMLElement;dispose():void} {
  const root=doc.createElement("section");root.className="fc-save-panel";
  const title=doc.createElement("h2");title.textContent=copy("ui.save.title");root.append(title);
  const status=doc.createElement("p");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const confirmation=doc.createElement("div");confirmation.className="fc-card";confirmation.hidden=true;
  const rows=doc.createElement("div");root.append(rows,confirmation,status);
  let disposed=false,busy=false,cancelConfirm:(()=>void)|undefined;
  const objectUrls=new Set<string>();
  function button(label:string,action:()=>void){const value=doc.createElement("button");value.type="button";value.textContent=label;value.addEventListener("click",action);return value;}
  function ask(message:string):Promise<boolean>{
    cancelConfirm?.();confirmation.replaceChildren();confirmation.hidden=false;
    const text=doc.createElement("p");text.textContent=message;
    return new Promise(resolve=>{const done=(answer:boolean)=>{confirmation.hidden=true;confirmation.replaceChildren();cancelConfirm=undefined;resolve(answer);};cancelConfirm=()=>done(false);const yes=button(copy("ui.common.confirm"),()=>done(true));confirmation.append(text,yes,button(copy("ui.common.cancel"),()=>done(false)));yes.focus();});
  }
  async function run(action:()=>Promise<void>):Promise<void>{
    if(busy||disposed)return;busy=true;status.textContent="";
    try{await action();}catch{if(!disposed)status.textContent=copy("ui.save.failed");}finally{busy=false;}
  }
  function exportSave(slot:SaveSlot):void {void run(async()=>{const text=await options.store.export(slot);if(disposed)return;const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));objectUrls.add(url);const link=doc.createElement("a");link.href=url;link.download=`fog-city-slot-${slot}.json`;root.append(link);link.click();link.remove();doc.defaultView?.setTimeout(()=>{URL.revokeObjectURL(url);objectUrls.delete(url);},1000);});}
  function importSave(slot:SaveSlot):void {
    const input=doc.createElement("input");input.type="file";input.accept="application/json,.json";input.hidden=true;root.append(input);
    input.addEventListener("change",()=>{const file=input.files?.[0];input.remove();if(!file)return;void run(async()=>{
      if(file.size>1024*1024){status.textContent=copy("ui.save.corrupt");return;}
      const imported=await options.store.import(slot,await file.text(),()=>ask(copy("ui.save.confirmLoad")));
      if(imported&&!disposed){status.textContent=copy("ui.save.autosaved");await refresh();}
    });},{once:true});input.click();
  }
  async function refresh():Promise<void>{
    const slots=await Promise.all((["auto",0,1,2] as const).map(async slot=>{try{return {slot,save:await options.store.load(slot),failed:false};}catch{return {slot,save:null,failed:true};}}));
    if(disposed)return;rows.replaceChildren();
    for(const {slot,save,failed}of slots){if(slot==="auto"&&!save)continue;const row=doc.createElement("article");row.className="fc-card";row.dataset.slot=String(slot);const label=doc.createElement("h3");label.textContent=copy("ui.save.slot",{slot:slot==="auto"?slot:slot+1});row.append(label);
      if(!save){const empty=doc.createElement("p");empty.textContent=copy(failed?"ui.save.corrupt":"ui.save.empty");row.append(empty);}
      if(slot!=="auto")row.append(button(copy("ui.save.save"),()=>void run(async()=>{await options.store.save(slot,options.capture());if(!disposed){status.textContent=copy("ui.save.autosaved");await refresh();}})));
      const load=button(copy("ui.save.load"),()=>void run(async()=>{if(!await ask(copy("ui.save.confirmLoad")))return;const current=await options.store.load(slot);if(current&&!disposed){await options.restore(current.data);status.textContent=copy("ui.common.done");}}));load.disabled=!save;
      const download=button(copy("ui.save.export"),()=>exportSave(slot));download.disabled=!save;
      row.append(load,download);if(slot!=="auto")row.append(button(copy("ui.save.import"),()=>importSave(slot)));rows.append(row);
    }
  }
  void refresh();
  return {element:root,dispose(){disposed=true;cancelConfirm?.();for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.clear();root.remove();}};
}
