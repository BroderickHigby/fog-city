import { LOADOUTS, PROGRESSION } from "../content/gameplay.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import { normalizeLoadoutChoice, loadoutSlots, STREAK_REWARDS } from "../sim/progression/rules.ts";
import { perkChoices } from "../sim/player/perks.ts";
import type { SimState } from "../sim/contract.ts";
import type { UiCopy } from "./types.ts";

export interface LoadoutChoiceView {id:string;label:string;description:string;group:string;selected:boolean;enabled:boolean;reason:string;banked?:number;callable?:boolean}
export interface LoadoutView {rank:number;points:number;perkSlots:number;streakSlots:number;pending:boolean;feedback:string;choices:readonly LoadoutChoiceView[]}
export function loadoutProjection(state:Readonly<SimState>,id:string,wave:number,copy:UiCopy):LoadoutView|undefined {
  if(state.version<27||wave<4)return undefined;
  const snapshot=gameplaySnapshot({state}),profile=snapshot.progression.players[id];if(!profile)return undefined;
  const owned=snapshot.economy.players[id]?.ownedItemIds??[],perkSlots=loadoutSlots("perkSlots",profile.rank,wave),streakSlots=loadoutSlots("streakSlots",profile.rank,wave);
  const choices:LoadoutChoiceView[]=[];
  const perks=perkChoices(profile.perks,{mode:"freeRoam",hasCoastline:true});
  const add=(item:{id:string;label:string;description:string},group:string)=>{
    const choice=normalizeLoadoutChoice(item.id);if(!choice)return;
    const selected=choice.kind==="perk"?profile.perks.includes(choice.value):choice.kind==="streak"?profile.streaks.includes(choice.value):profile[choice.kind]===choice.value;
    const locked=profile.rank<choice.rank,needsPurchase=choice.kind==="nozzle"&&choice.requiresOwnership&&!owned.some(id=>{const own=normalizeLoadoutChoice(id);return own?.kind==="nozzle"&&own.value===choice.value;});
    const full=choice.kind==="perk"?profile.perks.length>=perkSlots:choice.kind==="streak"?profile.streaks.length>=streakSlots:false;
    const unavailable=choice.kind==="perk"&&perks.find(perk=>perk.id===choice.value)?.enabled===false;
    const reason=locked?copy("ui.loadout.rankRequired",{rank:choice.rank}):needsPurchase?copy("ui.loadout.purchaseRequired"):unavailable?copy("ui.loadout.noCoast"):!selected&&full?copy("ui.loadout.slotsFull"):"";
    const banked=choice.kind==="streak"?profile.banked[choice.value]??0:undefined;
    choices.push({...item,group,selected,enabled:!reason,reason,...(banked!==undefined?{banked,callable:selected&&banked>0&&!profile.pendingStreak}:{})});
  };
  add({id:"standard-nozzle",label:copy("ui.loadout.standard"),description:copy("ui.loadout.standardDetail")},"nozzle");
  for(const item of PROGRESSION.upgrades.filter(item=>item.kind==="nozzle"))add({id:item.id,label:item.id==="wide-nozzle"?copy("ui.loadout.wide"):copy("ui.loadout.pressure"),description:copy("ui.loadout.nozzleDetail")},"nozzle");
  for(const item of LOADOUTS.gadgets)add(item,"gadget");
  add({id:"none",label:copy("ui.loadout.noGear"),description:copy("ui.loadout.noGearDetail")},"gear");
  for(const item of LOADOUTS.gear)add(item,"gear");
  for(const item of LOADOUTS.perks)add(item,"perk");
  for(const item of STREAK_REWARDS)add(item,"streak");
  const blocked=snapshot.progression.events.some(event=>event.playerId===id&&event.kind==="streak.blocked");
  return {rank:profile.rank,points:profile.streakPoints,perkSlots,streakSlots,pending:!!profile.pendingStreak,feedback:profile.pendingStreak?copy("ui.loadout.pending"):blocked?copy("ui.loadout.blocked"):"",choices};
}

/** Stable controls keep keyboard focus while a recorded command updates selection. */
export function mountLoadout(doc:Document,copy:UiCopy,callbacks:{select(id:string):void;call(id:string):void}) {
  const element=doc.createElement("section"),summary=doc.createElement("p"),feedback=doc.createElement("p");
  element.className="fc-loadout";feedback.setAttribute("role","status");element.append(summary,feedback);
  const rows=new Map<string,{root:HTMLElement;description:HTMLElement;reason:HTMLElement;select:HTMLButtonElement;call?:HTMLButtonElement}>();
  const groups=new Map<string,HTMLElement>();
  return {element,update(view:LoadoutView|undefined){
    if(!view){summary.textContent=copy("ui.loadout.unavailable");return;}
    summary.textContent=copy("ui.loadout.summary",{rank:view.rank,points:view.points,perks:view.perkSlots,streaks:view.streakSlots});feedback.textContent=view.feedback;
    for(const choice of view.choices){
      let row=rows.get(choice.id);
      if(!row){
        let group=groups.get(choice.group);if(!group){group=doc.createElement("fieldset");const title=doc.createElement("legend");title.textContent=copy(`ui.loadout.${choice.group}`);group.append(title);element.append(group);groups.set(choice.group,group);}
        const root=doc.createElement("div"),description=doc.createElement("p"),reason=doc.createElement("p"),select=doc.createElement("button");root.className="fc-loadout-choice";select.type="button";select.addEventListener("click",()=>callbacks.select(choice.id));reason.id=`loadout-${choice.id}-reason`;select.setAttribute("aria-describedby",reason.id);root.append(description,select,reason);
        const call=choice.banked!==undefined?doc.createElement("button"):undefined;
        if(call){call.type="button";call.addEventListener("click",()=>callbacks.call(choice.id));root.append(call);}
        group.append(root);row={root,description,reason,select,call};rows.set(choice.id,row);
      }
      row.description.textContent=choice.description;row.select.textContent=choice.label;row.select.setAttribute("aria-pressed",String(choice.selected));row.select.disabled=!choice.enabled;row.reason.textContent=choice.reason;
      if(row.call){row.call.textContent=copy("ui.loadout.call",{label:choice.label,count:choice.banked??0});row.call.disabled=!choice.callable;}
    }
  },dispose(){element.remove();}};
}
