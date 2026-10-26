import { matchKit } from "../content/kits.ts";
import { InputController, availableGamepads } from "../input/controller.ts";
import { Keyboard, isTextEntry } from "../input/keyboard.ts";
import { MenuGamepad } from "../input/menu-gamepad.ts";
import { bounded, formatMoney } from "./copy.ts";
import { createFreeTextBox, type FreeTextControl } from "./free-text.ts";
import { drawMap, releaseMapCache } from "./minimap.ts";
import { UI_STYLES } from "./styles.ts";
import { createTouchControls } from "./touch.ts";
import { createControlsHelp } from "./controls-help.ts";
import { mountSavePanel } from "./save-panel.ts";
import { mountCredits } from "./credits.ts";
import { Action } from "../sim/contract.ts";
import type { MapPoint, MountedGameUI, PhoneApp, UiLightingPreset, UiMountOptions, UiView } from "./types.ts";

const APPS:readonly PhoneApp[]=["map","botBounty","botCheck","ride","radio","fogcast","messages","bank","playlists","settings"];
/** Mount once, update with immutable projections, then dispose when leaving the game. */
export function mountGameUI(host:HTMLElement,options:UiMountOptions):MountedGameUI {
  const doc=options.document??host.ownerDocument,win=doc.defaultView!,copy=options.copy,callbacks=options.callbacks??{};
  const root=doc.createElement("section");root.className="fc-ui";root.setAttribute("aria-label",copy("ui.brand"));root.dataset.touch=String(!!options.touch);
  const style=doc.createElement("style");style.textContent=UI_STYLES;root.append(style);
  let view:UiView|undefined,modal:"phone"|"vendor"|"startup"|"pause"|"interaction"|"help"|undefined,app:PhoneApp|undefined,previousFocus:HTMLElement|null=null,freeText:FreeTextControl|undefined,disposed=false,panelStamp="",crisis=false,interactionId="";
  const keyboard=options.keyboard??new Keyboard(win,()=>!!modal||isTextEntry(doc.activeElement));const controls=new InputController(keyboard);
  let phoneMap:HTMLCanvasElement|undefined,phoneCenter:MapPoint|undefined,phoneRadius=400;
  let savePanel:ReturnType<typeof mountSavePanel>|undefined,audioPanel:{element:HTMLElement;dispose():void}|undefined,creditsPanel:{element:HTMLElement;dispose():void}|undefined;
  function node<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string,text?:string):HTMLElementTagNameMap[K]{const element=doc.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
  function button(label:string,fn:()=>void){const b=node("button",undefined,label);b.type="button";b.addEventListener("click",fn);return b;}
  const hud=node("div","fc-hud"),cluster=node("div","fc-cluster"),tools=node("div","fc-tools");
  const brand=node("div","fc-brand"),brandMark=node("span","fc-brand-mark","FC"),brandCopy=node("div");
  brandMark.setAttribute("aria-hidden","true");brandCopy.append(node("strong",undefined,copy("ui.brand")),node("small",undefined,copy("ui.hud.location")));brand.append(brandMark,brandCopy);
  const stats=new Map<string,HTMLElement>();
  for(const key of ["runway","cash","water","threat","reputation"]){const stat=node("div","fc-stat"),label=node("small",undefined,copy(`ui.hud.${key}`)),value=node("strong");stat.title=copy(`ui.hud.${key}`);stat.append(label,value);stats.set(key,value);cluster.append(stat);if(key==="water"){const progress=node("progress");progress.max=1;progress.value=0;progress.setAttribute("aria-label",copy("ui.hud.water"));stat.append(progress);}}
  const helpButton=button(copy("ui.help.open"),()=>setModal(modal==="help"?undefined:"help"));helpButton.className="fc-help-open";helpButton.setAttribute("aria-keyshortcuts","F1 Shift+Slash");
  if(callbacks.lighting){const lighting=node("select","fc-lighting");lighting.setAttribute("aria-label",copy("ui.hud.lighting"));for(const preset of ["live","noon","golden","twilight","night"] as const){const option=node("option",undefined,copy(`ui.hud.lighting.${preset}`));option.value=preset;lighting.append(option);}lighting.value=options.lightingPreset??"live";lighting.addEventListener("change",()=>{callbacks.lighting?.(lighting.value as UiLightingPreset);lighting.blur();});tools.append(lighting);}
  tools.append(button(copy("ui.phone.open"),()=>setModal("phone")),button(copy("ui.vendor.title"),()=>setModal("vendor")),helpButton);hud.append(brand,cluster,tools);
  const objective=node("aside","fc-objective"),objectiveTitle=node("h2"),objectiveDetail=node("p");objective.setAttribute("aria-label",copy("ui.hud.objective"));const resumeInteraction=button(copy("ui.common.continue"),()=>setModal("interaction"));resumeInteraction.hidden=true;objective.append(objectiveTitle,objectiveDetail,resumeInteraction);objective.hidden=true;
  const mini=button(copy("ui.phone.map"),()=>setModal("phone","map")),canvas=node("canvas"),street=node("span","fc-street",copy("ui.hud.location"));mini.className="fc-minimap";mini.replaceChildren(street,canvas);mini.setAttribute("aria-label",`${copy("ui.phone.map")} (M)`);mini.setAttribute("aria-keyshortcuts","M");canvas.setAttribute("role","img");canvas.setAttribute("aria-label",copy("ui.phone.map"));
  const speed=node("div","fc-speed"),mode=node("span","fc-travel-mode",copy("ui.hud.driveMode")),speedLine=node("div","fc-speed-line"),speedValue=node("strong",undefined,"0"),speedUnit=node("span",undefined," km/h");speedLine.append(speedValue,speedUnit);speed.append(mode,speedLine);
  const hints=node("div","fc-drive-hints");hints.setAttribute("aria-hidden","true");
  let hintMode="";
  const updateHints=(onFoot:boolean):void=>{
    const mode=onFoot?"foot":"vehicle";if(mode===hintMode)return;hintMode=mode;hints.replaceChildren();
    const keys=onFoot?[["W A S D","ui.hud.walkHint"],["Shift","ui.hud.runHint"],["E","ui.controls.fire"],["F","ui.hud.vehicleHint"],["H","ui.hud.takeoverHint"]]:[["W A S D","ui.hud.moveHint"],["F","ui.hud.vehicleHint"],["H","ui.hud.robotaxiHint"]];
    for(const [key,label]of keys){const item=node("span");item.append(node("kbd",undefined,key),doc.createTextNode(` ${copy(label!)}`));hints.append(item);}
  };
  updateHints(false);
  const perf=node("output","fc-perf");perf.hidden=!options.showPerformance;
  const ads=node("div","fc-ads"),layer=node("div","fc-modal-layer");layer.hidden=true;
  const reticle=node("div","fc-reticle");reticle.setAttribute("aria-hidden","true");reticle.hidden=true;root.append(hud,objective,mini,speed,hints,perf,reticle,ads,layer);host.append(root);
  const touch=options.touch?createTouchControls(doc,controls,copy):undefined;if(touch)root.append(touch.element);

  function setModal(next:typeof modal,phoneApp?:PhoneApp):void {
    if(disposed)return;
    if(!modal&&next)previousFocus=doc.activeElement as HTMLElement|null;
    modal=next;app=next==="phone"?phoneApp:undefined;if(!next){phoneCenter=undefined;phoneRadius=400;}panelStamp="";crisis=false;controls.setBlocked(!!modal);callbacks.pause?.(!!modal);
    reticle.hidden=true;
    if(touch)touch.element.hidden=!!modal;renderPanel();
    if(!modal)previousFocus?.focus();
  }
  function renderPanel():void {
    if(phoneMap){releaseMapCache(phoneMap);phoneMap=undefined;}
    savePanel?.dispose();savePanel=undefined;audioPanel?.dispose();audioPanel=undefined;creditsPanel?.dispose();creditsPanel=undefined;
    layer.hidden=!modal;if(!modal){freeText?.dispose();freeText=undefined;layer.replaceChildren();return;}
    freeText?.dispose();freeText=undefined;
    const dialog=node("section","fc-dialog");dialog.setAttribute("role","dialog");dialog.setAttribute("aria-modal","true");dialog.tabIndex=-1;
    const header=node("header"),title=node("h1",undefined,modal==="interaction"?(view?.interaction?.title??copy("ui.hud.objective")):copy(modal==="phone"?"ui.phone.title":modal==="vendor"?"ui.vendor.title":modal==="startup"?"ui.signup.title":modal==="help"?"ui.help.title":"ui.hud.pause"));
    title.id="fc-dialog-title";dialog.setAttribute("aria-labelledby",title.id);header.append(title,button(copy("ui.common.close"),()=>setModal(undefined)));dialog.append(header);
    if(modal==="phone")renderPhone(dialog);
    if(modal==="pause"&&options.audioSettings){audioPanel=options.audioSettings(doc);dialog.append(audioPanel.element);}
    if(modal==="pause"){creditsPanel=mountCredits(doc);dialog.append(creditsPanel.element);}
    if(modal==="help"||modal==="pause")dialog.append(createControlsHelp(doc,copy));
    if(modal==="vendor")for(const item of view?.vendor??[]){
      const card=node("article","fc-card"),footer=node("footer"),buy=button(copy(item.owned?"ui.vendor.owned":"ui.vendor.buy"),()=>callbacks.purchase?.(item.id,view?.vendorSiteId));buy.disabled=item.owned||!item.available||(view?.cashCents??0)<item.priceCents;
      card.append(node("h2",undefined,item.title),node("p",undefined,item.description));footer.append(node("strong",undefined,formatMoney(item.priceCents)),buy);card.append(footer);
      if(buy.disabled&&!item.owned)card.append(node("p",undefined,item.reason??copy(item.available?"ui.vendor.insufficient":"ui.vendor.unavailable")));dialog.append(card);
    }
    if(modal==="vendor"&&!view?.vendor?.length)dialog.append(node("p",undefined,copy("ui.common.empty")));
    if(modal==="interaction"&&view?.interaction){dialog.append(node("p",undefined,view.interaction.detail));for(const choice of view.interaction.choices)dialog.append(button(choice.label,()=>{callbacks.interaction?.(choice.id);setModal(undefined);}));}
    if(modal==="startup"||modal==="interaction"&&view?.interaction?.startup){
      freeText=createFreeTextBox(doc,{id:"startup",label:copy("ui.signup.label"),submitLabel:copy("ui.signup.submit"),copy,choices:options.startupChoices,resolve:matchKit,accept:result=>{if(result.kind==="kit"){callbacks.startup?.(result.kitId);setModal(undefined);}},crisis:active=>{crisis=active;controls.setBlocked(true);}});dialog.append(freeText.element);
    }
    layer.replaceChildren(dialog);dialog.focus();
  }
  function renderPhone(dialog:HTMLElement):void {
    if(view?.interaction)dialog.append(button(copy("ui.common.continue"),()=>setModal("interaction")));
    const apps=node("nav","fc-phone-apps");apps.setAttribute("aria-label",copy("ui.phone.title"));
    for(const key of APPS){const b=button(copy(`ui.phone.${key}`),()=>{app=key;callbacks.app?.(key);renderPanel();});b.disabled=!(view?.phoneApps??["map","botBounty","botCheck"]).includes(key);b.setAttribute("aria-pressed",String(key===app));apps.append(b);}
    dialog.append(apps);if(!app)return;
    const content=node("div","fc-phone-content");content.append(node("h2",undefined,copy(`ui.phone.${app}`)));
    if(app==="map"&&view){
      const map=node("canvas","fc-phone-map"),mapTools=node("div","fc-map-tools"),instructions=node("p","fc-map-instructions",copy("ui.map.keyboard"));
      phoneMap=map;phoneCenter??={x:view.x,z:view.z};map.tabIndex=0;map.setAttribute("role","application");map.setAttribute("aria-label",copy("ui.phone.map"));map.setAttribute("aria-keyshortcuts","ArrowUp ArrowDown ArrowLeft ArrowRight + - Enter");instructions.id="fc-map-instructions";map.setAttribute("aria-describedby",instructions.id);
      const paint=()=>{if(view)drawMap(map,view,400,0,phoneRadius,phoneCenter);};
      const zoom=(factor:number)=>{phoneRadius=Math.max(80,Math.min(5000,phoneRadius*factor));paint();};
      mapTools.append(button("+",()=>zoom(1/1.5)),button("−",()=>zoom(1.5)),button(copy("ui.map.recenter"),()=>{if(view)phoneCenter={x:view.x,z:view.z};paint();}));
      mapTools.children[0]!.setAttribute("aria-label",copy("ui.map.zoomIn"));mapTools.children[1]!.setAttribute("aria-label",copy("ui.map.zoomOut"));
      let drag:{id:number;x:number;y:number;center:MapPoint;moved:boolean}|undefined,ignoreClick=false;
      map.addEventListener("pointerdown",event=>{if(event.button!==0||!phoneCenter)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY,center:{...phoneCenter},moved:false};map.setPointerCapture?.(event.pointerId);});
      map.addEventListener("pointermove",event=>{if(!drag||drag.id!==event.pointerId)return;const r=map.getBoundingClientRect(),dx=event.clientX-drag.x,dz=event.clientY-drag.y;if(Math.hypot(dx,dz)<6&&!drag.moved)return;drag.moved=true;phoneCenter={x:drag.center.x-dx/Math.max(1,r.width)*phoneRadius*2,z:drag.center.z-dz/Math.max(1,r.height)*phoneRadius*2};paint();});
      map.addEventListener("pointerup",event=>{if(drag?.id===event.pointerId){ignoreClick=drag.moved;drag=undefined;}});map.addEventListener("pointercancel",()=>{drag=undefined;ignoreClick=false;});
      map.addEventListener("click",event=>{if(ignoreClick){ignoreClick=false;return;}if(!view||!phoneCenter)return;if(event.detail===0){callbacks.waypoint?.({...phoneCenter});return;}const r=map.getBoundingClientRect();callbacks.waypoint?.({x:phoneCenter.x+((event.clientX-r.left)/Math.max(1,r.width)-.5)*2*phoneRadius,z:phoneCenter.z+((event.clientY-r.top)/Math.max(1,r.height)-.5)*2*phoneRadius});});
      map.addEventListener("wheel",event=>{event.preventDefault();zoom(event.deltaY>0?1.25:1/1.25);},{passive:false});
      map.addEventListener("keydown",event=>{if(!phoneCenter)return;const step=phoneRadius*.2;if(event.key.startsWith("Arrow")){event.preventDefault();event.stopPropagation();phoneCenter={x:phoneCenter.x+(event.key==="ArrowRight"?step:event.key==="ArrowLeft"?-step:0),z:phoneCenter.z+(event.key==="ArrowDown"?step:event.key==="ArrowUp"?-step:0)};paint();}else if(event.key==="+"||event.key==="="||event.key==="-"||event.key==="−"){event.preventDefault();event.stopPropagation();zoom(event.key==="-"||event.key==="−"?1.5:1/1.5);}else if(event.key==="Enter"){event.preventDefault();event.stopPropagation();callbacks.waypoint?.({...phoneCenter});}});
      paint();content.append(mapTools,map,instructions);
      for(const blip of view.map?.blips??[]){if(blip.kind==="robot"&&!blip.confirmed)continue;content.append(button(blip.label,()=>callbacks.waypoint?.({x:blip.x,z:blip.z})));}
    }else if(app==="botBounty"){
      for(const bounty of view?.bounties??[]){if(!bounty.confirmed)continue;const card=node("article","fc-card");card.append(node("h2",undefined,bounty.title),node("p",undefined,bounty.detail),node("strong",undefined,`×${bounty.multiplier}`));content.append(card);}
      if(!view?.bounties?.some(b=>b.confirmed))content.append(node("p",undefined,copy("ui.common.empty")));
    }else if(app==="botCheck"){
      content.append(node("p",undefined,copy(view?.scan?(view.scan.bad?"ui.hud.scanBad":"ui.hud.scanGood"):"ui.hud.scanUnknown")));
      if(view?.scan)content.append(node("strong",undefined,copy("ui.hud.scanConfidence",{confidence:Math.round(bounded(view.scan.confidence,0,1)*100)})));
    }else if(app==="bank")content.append(node("strong",undefined,formatMoney(view?.cashCents??0)));
    else if(app==="settings"){if(options.audioSettings){audioPanel=options.audioSettings(doc);content.append(audioPanel.element);}if(options.saves){savePanel=mountSavePanel(doc,copy,options.saves);content.append(savePanel.element);}creditsPanel=mountCredits(doc);content.append(creditsPanel.element);}
    else content.append(node("p",undefined,copy("ui.common.empty")));
    dialog.append(content);
  }
  let adStamp="";
  function renderAds():void {
    const popups=(view?.popups??[]).slice(0,3),stamp=JSON.stringify(popups);if(stamp===adStamp)return;adStamp=stamp;ads.replaceChildren();
    for(const [index,popup]of popups.entries()){
      const card=node("aside","fc-ad"),close=button(copy("ui.ad.close"),()=>callbacks.closeAd?.(popup.id));card.setAttribute("aria-label",copy("ui.ad.counter",{number:index+1,total:popups.length}));
      let dodged=false;close.addEventListener("pointerenter",event=>{if(dodged||event.pointerType!=="mouse")return;dodged=true;close.style.float="left";});
      let startX:number|undefined;card.addEventListener("pointerdown",e=>{startX=e.clientX;});card.addEventListener("pointerup",e=>{if(startX!==undefined&&Math.abs(e.clientX-startX)>45)callbacks.closeAd?.(popup.id);startX=undefined;});card.addEventListener("pointercancel",()=>{startX=undefined;});
      card.append(close,node("small",undefined,copy("ui.ad.label")),node("h2",undefined,popup.title),node("p",undefined,popup.detail));ads.append(card);
    }
  }
  const keydown=(event:KeyboardEvent)=>{
    if(event.code==="Escape"){event.preventDefault();setModal(modal?undefined:"pause");return;}
    if(event.code==="Tab"&&modal){const focusable=[...layer.querySelectorAll<HTMLElement>("button:not(:disabled),textarea,select,[tabindex='0']")];const first=focusable[0],last=focusable.at(-1);if(!first)return;if(event.shiftKey&&(doc.activeElement===first||doc.activeElement===layer.firstElementChild)){last?.focus();event.preventDefault();}else if(!event.shiftKey&&(doc.activeElement===last||doc.activeElement===layer.firstElementChild)){first.focus();event.preventDefault();}}
    if(isTextEntry(event.target))return;
    if((event.code==="F1"||event.key==="?")&&!event.repeat){event.preventDefault();setModal(modal==="help"?undefined:"help");return;}
    if(event.code==="KeyM"&&!event.repeat){event.preventDefault();setModal(modal==="phone"&&app==="map"?undefined:"phone","map");return;}
    if(event.code==="KeyP"&&!event.repeat){event.preventDefault();setModal(modal==="phone"?undefined:"phone");}
  };win.addEventListener("keydown",keydown);
  const menuPad=new MenuGamepad({isOpen:()=>!!modal,toggle:()=>setModal(modal?undefined:"phone"),close:()=>setModal(undefined),move:delta=>{const items=[...layer.querySelectorAll<HTMLElement>("button:not(:disabled),textarea,select,[tabindex='0']")];if(!items.length)return;const index=items.indexOf(doc.activeElement as HTMLElement);items[(index+delta+items.length)%items.length]?.focus();},activate:()=>{(doc.activeElement as HTMLElement|null)?.click();}});
  let gamepadFrame=0;
  const pollPad=()=>{if(disposed)return;menuPad.update(availableGamepads(win.navigator).find(pad=>pad?.connected));gamepadFrame=win.requestAnimationFrame(pollPad);};gamepadFrame=win.requestAnimationFrame(pollPad);
  function update(next:UiView):void {
    if(disposed)return;view=next;
    const nextInteraction=next.interaction?.id??"";
    if(nextInteraction!==interactionId){interactionId=nextInteraction;if(next.interaction)setModal("interaction");else if(modal==="interaction")setModal(undefined);}
    stats.get("runway")!.textContent=`${bounded(next.runwayMonths,0,999).toFixed(1)} mo`;
    stats.get("cash")!.textContent=formatMoney(next.cashCents);stats.get("water")!.textContent="∞";
    stats.get("water")!.parentElement!.querySelector("small")!.textContent=copy(next.salt?"ui.hud.salt":"ui.hud.water");
    stats.get("water")!.parentElement!.dataset.alert=String(next.salt);stats.get("water")!.parentElement!.title=copy(next.salt?"ui.hud.salt":"ui.hud.fresh");
    stats.get("water")!.parentElement!.querySelector("progress")!.value=1;
    stats.get("threat")!.textContent=String(Math.round(bounded(next.threat,0,100)));stats.get("reputation")!.textContent=String(Math.round(bounded(next.reputation,-999,999)));
    objective.hidden=!next.objective&&!next.interaction;resumeInteraction.hidden=!next.interaction;objectiveTitle.textContent=next.objective?.title??next.interaction?.title??"";objectiveDetail.textContent=next.objective?.detail??next.interaction?.detail??"";
    speedValue.textContent=String(Math.round(bounded(next.speedMps,0,200)*3.6));
    mode.textContent=copy(next.vehicleControl==="robotaxi-driver"?"ui.hud.robotaxiDriver":next.vehicleControl==="robotaxi-passenger"?"ui.hud.robotaxiPassenger":next.travelMode==="foot"?"ui.hud.walkMode":"ui.hud.driveMode");
    speed.dataset.mode=next.travelMode??"vehicle";updateHints(next.travelMode==="foot");street.textContent=next.streetName??copy("ui.hud.location");drawMap(canvas,next);
    if(options.showPerformance&&next.performance)perf.textContent=`${Math.round(next.performance.fps)} fps · ${next.performance.drawCalls} calls · ${next.performance.triangles} tris${next.performance.backend?` · ${next.performance.backend}`:""}${next.performance.shadowCascades?` · ${next.performance.shadowCascades} sun cascades`:""}`;
    renderAds();if(phoneMap)drawMap(phoneMap,next,400,0,phoneRadius,phoneCenter);
    // Never replace a focused form while sim snapshots arrive.
    if(modal&&modal!=="startup"&&modal!=="interaction"){const stamp=JSON.stringify([next.vendor,next.bounties,next.scan,next.phoneApps,next.cashCents,next.map?.waypoint]);if(stamp!==panelStamp){panelStamp=stamp;const active=doc.activeElement as HTMLElement|null,mapFocused=active===phoneMap;const index=[...layer.querySelectorAll("button")].indexOf(active as HTMLButtonElement);renderPanel();if(mapFocused)phoneMap?.focus();else if(index>=0)(layer.querySelectorAll("button")[index] as HTMLElement|undefined)?.focus();}}
  }
  return{element:root,update,sampleInput:()=>{controls.setBlocked(!!modal||crisis||isTextEntry(doc.activeElement));const input=controls.sample();reticle.hidden=(input.actions&(Action.fire|Action.scan|Action.watch|Action.altFire))===0;return input;},hideReticle:()=>{reticle.hidden=true;},setPhoneOpen:open=>setModal(open?"phone":undefined),setVendorOpen:open=>setModal(open?"vendor":undefined),showStartup:()=>{setModal("startup");freeText?.focus();},dispose(){if(disposed)return;disposed=true;freeText?.dispose();savePanel?.dispose();audioPanel?.dispose();creditsPanel?.dispose();win.cancelAnimationFrame(gamepadFrame);releaseMapCache(canvas);if(phoneMap)releaseMapCache(phoneMap);if(!options.keyboard)keyboard.dispose();controls.releaseAll();touch?.dispose();win.removeEventListener("keydown",keydown);callbacks.pause?.(false);root.remove();}};
}
