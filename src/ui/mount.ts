import { matchKit } from "../content/kits.ts";
import { InputController, availableGamepads } from "../input/controller.ts";
import { Keyboard, isTextEntry } from "../input/keyboard.ts";
import { MenuGamepad } from "../input/menu-gamepad.ts";
import { bounded, formatMoney } from "./copy.ts";
import { createFreeTextBox, type FreeTextControl } from "./free-text.ts";
import { drawMap } from "./minimap.ts";
import { UI_STYLES } from "./styles.ts";
import { createTouchControls } from "./touch.ts";
import { localModeMenu, matchResults, matchTime } from "./modes.ts";
import { mountSavePanel } from "./save-panel.ts";
import type { MountedGameUI, PhoneApp, UiMountOptions, UiView } from "./types.ts";

const APPS:readonly PhoneApp[]=["map","botBounty","botCheck","ride","radio","fogcast","messages","bank","playlists","settings"];
/** Mount once, update with immutable projections, then dispose when leaving the game. */
export function mountGameUI(host:HTMLElement,options:UiMountOptions):MountedGameUI {
  const doc=options.document??host.ownerDocument,win=doc.defaultView!,copy=options.copy,callbacks=options.callbacks??{};
  const root=doc.createElement("section");root.className="fc-ui";root.setAttribute("aria-label",copy("ui.brand"));root.dataset.touch=String(!!options.touch);
  const style=doc.createElement("style");style.textContent=UI_STYLES;root.append(style);
  let view:UiView|undefined,modal:"phone"|"vendor"|"startup"|"pause"|"interaction"|"results"|undefined,app:PhoneApp|undefined,previousFocus:HTMLElement|null=null,freeText:FreeTextControl|undefined,disposed=false,panelStamp="",crisis=false,interactionId="",resultId="",matchStamp="";
  const keyboard=options.keyboard??new Keyboard(win,()=>!!modal||isTextEntry(doc.activeElement));const controls=new InputController(keyboard);
  let savePanel:ReturnType<typeof mountSavePanel>|undefined;
  function node<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string,text?:string):HTMLElementTagNameMap[K]{const element=doc.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
  function button(label:string,fn:()=>void){const b=node("button",undefined,label);b.type="button";b.addEventListener("click",fn);return b;}
  const hud=node("div","fc-hud"),cluster=node("div","fc-cluster"),tools=node("div","fc-tools");
  const stats=new Map<string,HTMLElement>();
  for(const key of ["runway","cash","water","threat","reputation"]){const stat=node("div","fc-stat"),label=node("small",undefined,copy(`ui.hud.${key}`)),value=node("strong");stat.append(label,value);stats.set(key,value);cluster.append(stat);if(key==="water"){const progress=node("progress");progress.max=1;progress.value=0;progress.setAttribute("aria-label",copy("ui.hud.water"));stat.append(progress);}}
  tools.append(button(copy("ui.phone.open"),()=>setModal("phone")),button(copy("ui.vendor.title"),()=>setModal("vendor")));hud.append(cluster,tools);
  const objective=node("aside","fc-objective"),objectiveTitle=node("h2"),objectiveDetail=node("p");objective.setAttribute("aria-label",copy("ui.hud.objective"));objective.append(objectiveTitle,objectiveDetail);objective.hidden=true;
  const mini=node("div","fc-minimap"),canvas=node("canvas");canvas.setAttribute("aria-label",copy("ui.phone.map"));mini.append(canvas);
  const matchHud=node("aside","fc-match-hud");matchHud.hidden=true;
  const speed=node("div","fc-speed"),perf=node("output","fc-perf");perf.hidden=!options.showPerformance;
  const ads=node("div","fc-ads"),layer=node("div","fc-modal-layer");layer.hidden=true;
  const reticle=node("div","fc-reticle");reticle.setAttribute("aria-hidden","true");root.append(hud,objective,mini,speed,perf,reticle,ads,matchHud,layer);host.append(root);
  const touch=options.touch?createTouchControls(doc,controls,copy):undefined;if(touch)root.append(touch.element);

  function setModal(next:typeof modal):void {
    if(disposed)return;
    if(!modal&&next)previousFocus=doc.activeElement as HTMLElement|null;
    modal=next;app=undefined;panelStamp="";crisis=false;controls.setBlocked(!!modal);callbacks.pause?.(!!modal);
    if(touch)touch.element.hidden=!!modal;renderPanel();
    if(!modal)previousFocus?.focus();
  }
  function renderPanel():void {
    savePanel?.dispose();savePanel=undefined;
    layer.hidden=!modal;if(!modal){freeText?.dispose();freeText=undefined;layer.replaceChildren();return;}
    freeText?.dispose();freeText=undefined;
    const dialog=node("section","fc-dialog");dialog.setAttribute("role","dialog");dialog.setAttribute("aria-modal","true");dialog.tabIndex=-1;
    const header=node("header"),title=node("h1",undefined,modal==="interaction"?(view?.interaction?.title??copy("ui.hud.objective")):modal==="results"?copy("ui.match.results"):copy(modal==="phone"?"ui.phone.title":modal==="vendor"?"ui.vendor.title":modal==="startup"?"ui.signup.title":"ui.hud.pause"));
    title.id="fc-dialog-title";dialog.setAttribute("aria-labelledby",title.id);header.append(title,button(copy("ui.common.close"),()=>setModal(undefined)));dialog.append(header);
    if(modal==="phone")renderPhone(dialog);
    if(modal==="results"&&view?.match)dialog.append(matchResults(doc,copy,view.match,()=>{callbacks.returnFromMode?.();setModal(undefined);}));
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
    const apps=node("nav","fc-phone-apps");apps.setAttribute("aria-label",copy("ui.phone.title"));
    for(const key of APPS){const b=button(copy(`ui.phone.${key}`),()=>{app=key;callbacks.app?.(key);renderPanel();});b.disabled=!(view?.phoneApps??["map","botBounty","botCheck"]).includes(key);b.setAttribute("aria-pressed",String(key===app));apps.append(b);}
    dialog.append(apps);if(!app)return;
    const content=node("div","fc-phone-content");content.append(node("h2",undefined,copy(`ui.phone.${app}`)));
    if(app==="map"&&view){
      const map=node("canvas","fc-phone-map");map.tabIndex=0;map.setAttribute("role","img");map.setAttribute("aria-label",copy("ui.phone.map"));drawMap(map,view,400,0,view.map?.radius??200);
      map.addEventListener("click",event=>{if(!view)return;const r=map.getBoundingClientRect(),radius=view.map?.radius??200;callbacks.waypoint?.({x:view.x+((event.clientX-r.left)/r.width-.5)*2*radius,z:view.z+((event.clientY-r.top)/r.height-.5)*2*radius});});content.append(map);
      for(const blip of view.map?.blips??[]){if(blip.kind==="robot"&&!blip.confirmed)continue;content.append(button(blip.label,()=>callbacks.waypoint?.({x:blip.x,z:blip.z})));}
    }else if(app==="botBounty"){
      for(const bounty of view?.bounties??[]){if(!bounty.confirmed)continue;const card=node("article","fc-card");card.append(node("h2",undefined,bounty.title),node("p",undefined,bounty.detail),node("strong",undefined,`×${bounty.multiplier}`));content.append(card);}
      if(!view?.bounties?.some(b=>b.confirmed))content.append(node("p",undefined,copy("ui.common.empty")));
    }else if(app==="botCheck"){
      content.append(node("p",undefined,copy(view?.scan?(view.scan.bad?"ui.hud.scanBad":"ui.hud.scanGood"):"ui.hud.scanUnknown")));
      if(view?.scan)content.append(node("strong",undefined,copy("ui.hud.scanConfidence",{confidence:Math.round(bounded(view.scan.confidence,0,1)*100)})));
    }else if(app==="playlists"&&options.localModes){
      if(view?.match)content.append(button(copy("ui.match.return"),()=>{if(view?.match?.phase==="finished")callbacks.returnFromMode?.();else callbacks.cancelMode?.();setModal(undefined);}));
      else content.append(localModeMenu(doc,copy,options.localModes,mode=>{if(callbacks.startMode?.(mode))setModal(undefined);}));
      if(view?.modeError){const message=node("p",undefined,view.modeError);message.setAttribute("role","alert");content.append(message);}
    }else if(app==="bank")content.append(node("strong",undefined,formatMoney(view?.cashCents??0)));
    else if(app==="settings"&&options.saves){savePanel=mountSavePanel(doc,copy,options.saves);content.append(savePanel.element);}
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
    if(event.code==="KeyP"&&!event.repeat){event.preventDefault();setModal(modal==="phone"?undefined:"phone");}
  };win.addEventListener("keydown",keydown);
  const menuPad=new MenuGamepad({isOpen:()=>!!modal,toggle:()=>setModal(modal?undefined:"phone"),close:()=>setModal(undefined),move:delta=>{const items=[...layer.querySelectorAll<HTMLElement>("button:not(:disabled),textarea,select,[tabindex='0']")];if(!items.length)return;const index=items.indexOf(doc.activeElement as HTMLElement);items[(index+delta+items.length)%items.length]?.focus();},activate:()=>{(doc.activeElement as HTMLElement|null)?.click();}});
  let gamepadFrame=0;
  const pollPad=()=>{if(disposed)return;menuPad.update(availableGamepads(win.navigator).find(pad=>pad?.connected));gamepadFrame=win.requestAnimationFrame(pollPad);};gamepadFrame=win.requestAnimationFrame(pollPad);
  function update(next:UiView):void {
    if(disposed)return;view=next;
    const finished=next.match?.phase==="finished"?next.match.id:"";
    if(finished&&finished!==resultId){resultId=finished;setModal("results");}else if(!next.match){resultId="",matchStamp="";if(modal==="results")setModal(undefined);}
    matchHud.hidden=!next.match;
    const nextMatchStamp=JSON.stringify(next.match);
    if(next.match&&nextMatchStamp!==matchStamp){matchStamp=nextMatchStamp;const m=next.match;matchHud.replaceChildren(node("strong",undefined,copy(`ui.mode.${m.mode}`)),node("span",undefined,matchTime(m.remainingTicks)),node("span",undefined,`${copy("ui.match.score")}: ${m.score}`),node("span",undefined,`${copy("ui.match.remaining")}: ${m.objectivesRemaining}`));if(m.phase==="finished")matchHud.append(button(copy("ui.match.results"),()=>setModal("results")));}
    const nextInteraction=next.interaction?.id??"";
    if(nextInteraction!==interactionId){interactionId=nextInteraction;if(next.interaction&&!next.match)setModal("interaction");else if(modal==="interaction")setModal(undefined);}
    stats.get("runway")!.textContent=`${bounded(next.match?.runway??next.runwayMonths,0,999).toFixed(1)} mo`;
    stats.get("cash")!.textContent=formatMoney(next.cashCents);stats.get("water")!.textContent=`${bounded(next.waterLitres,0,9999).toFixed(1)} / ${bounded(next.capacityLitres,0,9999).toFixed(0)} L`;
    stats.get("water")!.parentElement!.querySelector("small")!.textContent=copy(next.salt?"ui.hud.salt":"ui.hud.water");
    stats.get("water")!.parentElement!.dataset.alert=String(next.salt);stats.get("water")!.parentElement!.title=copy(next.salt?"ui.hud.salt":"ui.hud.fresh");
    stats.get("water")!.parentElement!.querySelector("progress")!.value=next.capacityLitres>0?bounded(next.waterLitres/next.capacityLitres,0,1):0;
    stats.get("threat")!.textContent=String(Math.round(bounded(next.threat,0,100)));stats.get("reputation")!.textContent=String(Math.round(bounded(next.reputation,-999,999)));
    objective.hidden=!next.objective;if(next.objective){objectiveTitle.textContent=next.objective.title;objectiveDetail.textContent=next.objective.detail;}
    speed.textContent=`${Math.round(bounded(next.speedMps,0,200)*3.6)} km/h`;drawMap(canvas,next);
    if(options.showPerformance&&next.performance)perf.textContent=`${Math.round(next.performance.fps)} fps · ${next.performance.drawCalls} calls · ${next.performance.triangles} tris`;
    renderAds();
    // Never replace a focused form while sim snapshots arrive.
    if(modal&&modal!=="startup"&&modal!=="interaction"&&modal!=="results"){const stamp=JSON.stringify([next.vendor,next.bounties,next.scan,next.phoneApps,next.cashCents,next.map?.waypoint,next.match?.id,next.modeError]);if(stamp!==panelStamp){panelStamp=stamp;const active=doc.activeElement as HTMLElement|null;const index=[...layer.querySelectorAll("button")].indexOf(active as HTMLButtonElement);renderPanel();if(index>=0)(layer.querySelectorAll("button")[index] as HTMLElement|undefined)?.focus();}}
  }
  return{element:root,update,sampleInput:()=>{controls.setBlocked(!!modal||crisis||isTextEntry(doc.activeElement));return controls.sample();},setPhoneOpen:open=>setModal(open?"phone":undefined),setVendorOpen:open=>setModal(open?"vendor":undefined),showStartup:()=>{setModal("startup");freeText?.focus();},dispose(){if(disposed)return;disposed=true;freeText?.dispose();savePanel?.dispose();win.cancelAnimationFrame(gamepadFrame);if(!options.keyboard)keyboard.dispose();controls.releaseAll();touch?.dispose();win.removeEventListener("keydown",keydown);callbacks.pause?.(false);root.remove();}};
}
