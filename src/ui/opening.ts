import type { OpeningStatus } from "../audio/opening.ts";

/** Nonmodal story controls leave the city and ordinary movement available. */
export function mountOpeningControls(host:HTMLElement,onSkip:()=>void):{update(status:OpeningStatus):void;dispose():void} {
  const doc=host.ownerDocument,root=doc.createElement("aside"),label=doc.createElement("span"),skip=doc.createElement("button"),style=doc.createElement("style");
  root.className="fc-opening";root.setAttribute("aria-label","Opening story");root.hidden=true;
  style.textContent=".fc-opening{position:fixed;top:112px;left:50%;transform:translateX(-50%);z-index:25;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 24px);padding:6px 8px 6px 14px;background:#17252be8;border:1px solid #adc9c340;border-radius:10px;color:#eef5f0;font:13px/1.3 system-ui;pointer-events:auto}.fc-opening[hidden]{display:none}body:has(.fc-runway:not([hidden])) .fc-opening{top:72px;left:16px;transform:none}.fc-opening span{min-width:0}.fc-opening button{flex:none;min-height:44px;padding:8px 12px;border:1px solid #b1d1c35c;border-radius:7px;background:#29413d;color:inherit;font:600 13px system-ui;cursor:pointer}.fc-opening button:focus-visible{outline:3px solid #b7edca;outline-offset:2px}@media(max-width:600px){.fc-opening{top:102px;width:max-content;max-width:calc(100vw - 20px);font-size:12px}}";
  skip.type="button";skip.textContent="Skip story";skip.addEventListener("click",onSkip);
  // Enter/Space on this button must never also fire the blaster or brake the car.
  const stopKeys=(event:KeyboardEvent)=>{if(event.code!=="Escape")event.stopPropagation();};root.addEventListener("keydown",stopKeys);root.addEventListener("keyup",stopKeys);
  root.append(style,label,skip);host.append(root);
  return {update(status){root.hidden=!status.active;label.textContent=`Opening · ${status.line}/${status.total} · AI narrator`;root.title=status.disclosure;},dispose(){skip.removeEventListener("click",onSkip);root.removeEventListener("keydown",stopKeys);root.removeEventListener("keyup",stopKeys);root.remove();}};
}
