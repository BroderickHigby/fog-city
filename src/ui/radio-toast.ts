// The car radio's station card: shown for a few seconds when the player gets into a car or
// tunes (M / Shift+M), like a car stereo's display. Presentation only.

export const RADIO_TOAST_STYLES=`.fc-radio{position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:19;padding:8px 16px;border-radius:10px;background:#050d12e0;border:1px solid #64838a;color:#f4f5ed;font:500 14px/1.35 system-ui,sans-serif;text-align:center;pointer-events:none;transition:opacity .35s}.fc-radio[hidden]{display:none}.fc-radio strong{display:block;color:#9af4c3;font-size:16px}.fc-radio small{color:#bcd1d4}.fc-radio[data-fading=true]{opacity:0}`;
/** How long the card stays, ms (then fades). */
export const RADIO_TOAST_MS=3200;

export interface MountedRadioToast {
  readonly element:HTMLElement;
  show(name:string,tagline:string,nowMs:number):void;
  /** Hide the card once its time is up; call every frame. */
  update(nowMs:number):void;
  dispose():void;
}

export function mountRadioToast(host:HTMLElement,doc:Document=host.ownerDocument):MountedRadioToast {
  const root=doc.createElement("div");root.className="fc-radio";root.hidden=true;root.setAttribute("role","status");root.setAttribute("aria-live","polite");
  const style=doc.createElement("style");style.textContent=RADIO_TOAST_STYLES;
  const name=doc.createElement("strong"),tagline=doc.createElement("small");root.append(name,tagline);host.append(style,root);
  let until=0;
  return {element:root,show(stationName,stationTagline,nowMs){name.textContent=`📻 ${stationName}`;tagline.textContent=stationTagline;root.hidden=false;root.dataset.fading="false";until=nowMs+RADIO_TOAST_MS;},
    update(nowMs){if(root.hidden)return;if(nowMs>=until)root.hidden=true;else root.dataset.fading=String(until-nowMs<400);},
    dispose(){root.remove();style.remove();}};
}
