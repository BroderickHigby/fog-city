import { taxiSessionView } from "../modes/taxi-session.ts";
import type { TaxiSession } from "../modes/taxi-session.ts";
import type { TaxiCommandKind } from "../sim/modes/taxi.ts";

export type TaxiShiftChoice="day"|"night"|"fog-rain";
export interface TaxiModeControlOptions {
  title?:string;
  onStart(shift:TaxiShiftChoice):void;
  onCommand(command:TaxiCommandKind):void;
  /** Host can release/suspend held driving controls while an actual form control has focus. */
  onFocusChange?(focused:boolean):void;
  onModal?(open:boolean):void;
}
export interface TaxiModeControl {
  element:HTMLElement;
  open():void;
  close():void;
  update(session:Readonly<TaxiSession>|null,status?:{available?:boolean;reason?:string;busy?:boolean;error?:string}):void;
  setStatus(status:{available?:boolean;reason?:string;busy?:boolean;error?:string}):void;
  dispose():void;
}
const STYLE=`
.fc-taxi{position:fixed;left:16px;bottom:18px;z-index:24;width:min(340px,calc(100vw - 32px));max-height:calc(100dvh - 110px);overflow:auto;color:#f4f5ed;font:500 14px/1.4 "Avenir Next","Trebuchet MS",sans-serif;pointer-events:auto;--taxi-accent:#b7edca;--taxi-line:#ffffff28}
.fc-taxi *{box-sizing:border-box}.fc-taxi [hidden]{display:none!important}.fc-taxi button{font:inherit;min-height:44px;border:1px solid var(--taxi-line);border-radius:9px;background:#1d2427;color:inherit;padding:10px 13px;cursor:pointer;touch-action:manipulation}.fc-taxi button:hover{background:#35413f}.fc-taxi button:disabled{opacity:.55;cursor:default}.fc-taxi :focus-visible{outline:3px solid var(--taxi-accent);outline-offset:3px}.fc-taxi button.fc-taxi-primary{background:var(--taxi-accent);color:#17231c;border-color:var(--taxi-accent);font-weight:700}
.fc-taxi-body{padding:16px;background:#171d20;border:1px solid var(--taxi-line);border-radius:12px}.fc-taxi h2{margin:0 0 8px;font-size:20px;line-height:1.2;letter-spacing:-.02em}.fc-taxi p{margin:8px 0;overflow-wrap:anywhere}.fc-taxi small{font-size:13px;color:#c7d4ce}.fc-taxi-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.fc-taxi-heading h2{min-width:0;overflow-wrap:anywhere}.fc-taxi-heading button{min-width:44px;margin-top:-6px;padding-inline:10px}
.fc-taxi fieldset{border:0;margin:16px 0;padding:0;min-width:0}.fc-taxi legend{font-weight:650;margin-bottom:4px}.fc-taxi-choice{display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer}.fc-taxi-choice input{width:20px;height:20px;accent-color:var(--taxi-accent);flex:none;margin:0}.fc-taxi-choice span{display:block;line-height:1.3}.fc-taxi-choice small{display:block}.fc-taxi-intro{color:#c7d4ce}.fc-taxi-route{padding-block:10px;border-block:1px solid var(--taxi-line)}.fc-taxi-route strong{display:block;font-size:16px;font-weight:650}.fc-taxi-stats{display:flex;gap:12px;flex-wrap:wrap;margin-block:12px}.fc-taxi-stats span{white-space:nowrap}.fc-taxi-stats strong{font-variant-numeric:tabular-nums;color:var(--taxi-accent)}.fc-taxi-stop{display:grid;gap:5px;margin-block:12px}.fc-taxi-stop progress{display:block;accent-color:var(--taxi-accent);width:100%;height:8px}.fc-taxi-stop span{font-size:13px;color:#c7d4ce}.fc-taxi-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.fc-taxi-actions button{flex:1 1 auto}.fc-taxi-error{color:#ffd4a2}.fc-taxi-status{color:#c7d4ce}.fc-taxi .fc-taxi-status:empty,.fc-taxi .fc-taxi-error:empty{display:none}.fc-taxi-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
@media(max-width:600px){.fc-taxi{left:10px;bottom:174px;width:min(320px,calc(100vw - 20px));max-height:calc(100dvh - 260px)}.fc-taxi-body{padding:12px}.fc-taxi h2{font-size:18px}.fc-taxi-route{padding-block:7px}.fc-taxi-stats{margin-block:8px}.fc-taxi-actions{margin-top:10px}}@media(max-height:520px){.fc-taxi{bottom:10px;max-height:calc(100dvh - 80px)}.fc-taxi-intro{display:none}}
`;
const REASONS:Readonly<Record<string,string>>={
  "manual-grounded-vehicle-required":"Use your own car or a car you are driving. Keep all wheels on dry ground.",
  "return-to-boarded-vehicle":"Your passenger is in the car you picked them up in. Return to that car.",
  "outside-stop-zone":"Drive into the marked stop, then hold the brake.",
  "stop-vehicle":"Brake to a complete stop.",
  "keep-people-clear":"Give people and animals more room before stopping.",
  "waiting-passenger-required":"Your passenger is waiting at the marked curb. Pull alongside with room to board.",
  "hold-still-before-interact":"Keep the car still for two seconds, release Interact, then press it again.",
  "route-validation-pending":"This route is being checked. Wait, choose another passenger, or retry.",
  "route-blocked":"The stop is blocked. Wait for it to clear, retry, or exit the shift.",
  "pickup-timeout":"The passenger's wait ran out. Retry for another pickup, or return to the city.",
  "trip-timeout":"The fare's time ran out. Earlier earnings are kept. Retry or return to the city.",
  "shift-timeout":"Your shift is over. Retry for another shift, or bank your earnings and return to the city.",
  "player-cancel":"Fare cancelled. Earlier earnings are kept. Retry or return to the city.",
  "ledger-capacity":"This run is complete. Bank your earnings and return to the city.",
  "attempt-capacity":"This run is complete. Bank your earnings and return to the city.",
  "trip-capacity":"This run is complete. Bank your earnings and return to the city.",
};
const clock=(ticks:number)=>{const seconds=Math.max(0,Math.ceil(ticks/60));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;};
const money=(cents:number)=>`$${(cents/100).toFixed(2)}`;
let panelSequence=0;
/** Native controls are retained between ticks; timer updates never replace a focused button. */
export function mountTaxiModeControl(host:HTMLElement,options:TaxiModeControlOptions):TaxiModeControl {
  const doc=host.ownerDocument,id=`fc-taxi-${++panelSequence}`;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string,text?:string):HTMLElementTagNameMap[K]=>{const el=doc.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
  const root=node("section","fc-taxi"),style=node("style");style.textContent=STYLE;root.setAttribute("aria-label","Taxi shifts");
  const launcher=node("button",undefined,"Taxi shifts");launcher.type="button";launcher.setAttribute("aria-expanded","false");launcher.setAttribute("aria-controls",id);
  const body=node("div","fc-taxi-body");body.id=id;body.hidden=true;
  const heading=node("div","fc-taxi-heading"),title=node("h2",undefined,options.title??"Crazy Uber"),close=node("button",undefined,"Close");close.type="button";close.setAttribute("aria-label","Close taxi shift choices");heading.append(title,close);
  const chooser=node("div"),intro=node("p","fc-taxi-intro","Pick up passengers around San Francisco, stop safely, and earn a fare before the clock runs out."),fieldset=node("fieldset"),legend=node("legend",undefined,"Choose a shift");fieldset.append(legend);
  let selected:TaxiShiftChoice="day",session:Readonly<TaxiSession>|null=null,available=true,busy=false,disposed=false,announcement="",modal=false,returnFocus:HTMLElement|null=null;
  const radios:HTMLInputElement[]=[];
  for(const choice of [{id:"day",label:"Day",detail:"A daylight shift across the city"},{id:"night",label:"Night",detail:"A late shift across the city"},{id:"fog-rain",label:"Fog and rain",detail:"Wet roads and shorter sightlines"}] as const){
    const label=node("label","fc-taxi-choice"),input=node("input"),text=node("span"),name=node("strong",undefined,choice.label),detail=node("small",undefined,choice.detail);input.type="radio";input.name=`${id}-shift`;input.value=choice.id;input.checked=choice.id===selected;input.setAttribute("aria-label",choice.label);input.addEventListener("change",()=>{if(input.checked)selected=choice.id;});text.append(name,detail);label.append(input,text);fieldset.append(label);radios.push(input);
  }
  const start=node("button","fc-taxi-primary","Start shift");start.type="button";const startNote=node("p",undefined,"Brake to a stop for two seconds, then press R / controller Y to board or drop off. Your city progress stays saved.");const availabilityNote=node("p","fc-taxi-status");chooser.append(intro,fieldset,start,startNote,availabilityNote);
  const hud=node("div"),phase=node("p"),route=node("div","fc-taxi-route"),targetLabel=node("small"),target=node("strong"),district=node("small");route.append(targetLabel,target,district);
  const stats=node("div","fc-taxi-stats"),fare=node("span"),fareValue=node("strong"),time=node("span"),timeValue=node("strong"),shift=node("span"),shiftValue=node("strong");fare.append("Earned ",fareValue);time.append("Fare ",timeValue);shift.append("Shift ",shiftValue);stats.append(fare,time,shift);
  const stop=node("div","fc-taxi-stop"),stopLabel=node("span"),progress=node("progress");progress.setAttribute("aria-label","Continuous safe stop");stop.append(stopLabel,progress);
  const instruction=node("p"),recovery=node("p","fc-taxi-status"),actions=node("div","fc-taxi-actions");
  const buttons=new Map<TaxiCommandKind,HTMLButtonElement>();
  for(const [kind,label] of [["next","Next passenger"],["retry","Retry shift"],["cancel","Cancel fare"],["exit","Bank & exit"]] as const){const button=node("button",kind==="next"?"fc-taxi-primary":undefined,label);button.type="button";button.addEventListener("click",()=>{options.onCommand(kind);button.blur();});buttons.set(kind,button);actions.append(button);}
  const notice=node("p","fc-taxi-sr");notice.setAttribute("role","status");notice.setAttribute("aria-live","polite");
  const error=node("p","fc-taxi-error");error.setAttribute("role","alert");
  hud.append(phase,route,stats,stop,instruction,recovery,actions,notice);hud.hidden=true;body.append(heading,chooser,hud,error);root.append(style,launcher,body);host.append(root);launcher.hidden=true;
  const showChooser=(open:boolean)=>{body.hidden=!open;launcher.setAttribute("aria-expanded",String(open));const nextModal=open&&!session;if(modal!==nextModal){modal=nextModal;options.onModal?.(modal);}if(modal){body.setAttribute("role","dialog");body.setAttribute("aria-modal","true");body.setAttribute("aria-label",title.textContent??"Taxi shift");}else{body.removeAttribute("role");body.removeAttribute("aria-modal");}};
  const closeChoices=()=>{if(!session){showChooser(false);if(returnFocus?.isConnected)returnFocus.focus();}else{options.onModal?.(false);}};
  const onKey=(event:KeyboardEvent)=>{event.stopPropagation();if(event.code==="Escape"&&modal){event.preventDefault();closeChoices();}if(event.code==="Tab"&&modal){const controls=[close,...radios.filter(input=>input.checked),start].filter(control=>!control.disabled&&!control.hidden),first=controls[0],last=controls.at(-1);if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus();}}};root.addEventListener("keydown",onKey);
  const onFocusIn=()=>options.onFocusChange?.(true),onFocusOut=()=>{queueMicrotask(()=>{if(!disposed&&!root.contains(doc.activeElement))options.onFocusChange?.(false);});};root.addEventListener("focusin",onFocusIn);root.addEventListener("focusout",onFocusOut);
  launcher.addEventListener("click",()=>{showChooser(Boolean(body.hidden));if(!body.hidden)radios.find(input=>input.checked)?.focus();});
  close.addEventListener("click",closeChoices);
  start.addEventListener("click",()=>{if(!busy&&available){error.textContent="";options.onStart(selected);start.blur();}});
  function render():void {
    if(disposed)return;const active=!!session&&session.taxi.phase!=="exited";
    root.setAttribute("aria-busy",String(busy));launcher.hidden=true;close.hidden=active;chooser.hidden=active;hud.hidden=!active;start.disabled=!available||busy;radios.forEach(input=>{input.disabled=!available||busy;});
    if(!active){title.textContent=options.title??"Crazy Uber";return;}
    showChooser(true);launcher.setAttribute("aria-expanded","true");const current=session!,view=taxiSessionView(current);
    title.textContent=view.title;
    phase.textContent=({pickup:"Pick up your passenger",driving:"Take your passenger to the destination","fare-complete":"Fare complete",blocked:"Stop blocked",timeout:"Fare timed out",cancelled:"Fare cancelled",finished:"Shift complete",exited:"Back to the city"} as const)[view.phase];
    const driving=view.phase==="driving"||view.phase==="blocked"&&current.taxi.trip.resumePhase==="driving";
    targetLabel.textContent=driving?"Destination":"Pickup";target.textContent=driving?view.route.destinationLabel:view.route.pickupLabel;district.textContent=`${view.route.pickupDistrict} to ${view.route.destinationDistrict}`;
    fareValue.textContent=money(current.taxi.totalCashCents);time.firstChild!.textContent=driving?"Trip ":"Pickup ";timeValue.textContent=clock(view.remainingTicks);shiftValue.textContent=clock(view.shiftRemainingTicks);
    const canStop=view.phase==="pickup"||view.phase==="driving";stop.hidden=!canStop;progress.max=view.stopRequiredTicks;progress.value=Math.min(view.stopTicks,view.stopRequiredTicks);progress.setAttribute("aria-valuetext",`${Math.min(view.stopTicks/60,view.stopRequiredTicks/60).toFixed(1)} of ${(view.stopRequiredTicks/60).toFixed(1)} seconds stopped`);stopLabel.textContent=`Safe stop: ${Math.min(view.stopTicks/60,view.stopRequiredTicks/60).toFixed(1)} / ${(view.stopRequiredTicks/60).toFixed(1)} seconds`;
    instruction.hidden=!canStop;instruction.textContent=view.stopTicks>=view.stopRequiredTicks?`Press R / controller Y to ${driving?"drop off":"pick up"}.`:(view.stopTicks>0?"Hold the brake and keep the car still.":"Drive into the marked stop, then hold the brake.");
    recovery.textContent=REASONS[view.reason]??(view.phase==="fare-complete"?"Fare banked for this run. Choose the next passenger or exit to keep your earnings.":"");
    buttons.get("next")!.hidden=!view.canNext;buttons.get("retry")!.hidden=!view.canRetry;buttons.get("cancel")!.hidden=!["pickup","driving","blocked"].includes(view.phase);buttons.forEach(button=>{button.disabled=busy;});buttons.get("exit")!.textContent=current.taxi.totalCashCents>0?"Bank & exit":"Exit to city";
    const announcementKey=`${current.taxi.trip.id}:${view.phase}`;
    if(announcementKey!==announcement){announcement=announcementKey;notice.textContent=`${phase.textContent}. ${view.phase==="pickup"?view.route.pickupLabel:view.phase==="driving"?view.route.destinationLabel:recovery.textContent}`;}
  }
  const status=(value:{available?:boolean;reason?:string;busy?:boolean;error?:string})=>{if(value.available!==undefined)available=value.available;if(value.busy!==undefined)busy=value.busy;if(value.reason!==undefined)availabilityNote.textContent=value.reason;if(value.error!==undefined){error.textContent=value.error;if(value.error)showChooser(true);}render();};
  return {element:root,open(){if(!root.contains(doc.activeElement))returnFocus=doc.activeElement as HTMLElement|null;showChooser(true);if(!session)radios.find(input=>input.checked)?.focus();},close:closeChoices,update(next,value){const entering=!session&&!!next,leaving=!!session&&!next;session=next;if(entering&&root.contains(doc.activeElement))(doc.activeElement as HTMLElement|null)?.blur?.();if(leaving)showChooser(false);if(value)status(value);else render();},setStatus:status,dispose(){disposed=true;root.removeEventListener("keydown",onKey);root.removeEventListener("focusin",onFocusIn);root.removeEventListener("focusout",onFocusOut);options.onFocusChange?.(false);options.onModal?.(false);root.remove();}};
}
