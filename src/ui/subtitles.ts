// Mission subtitles: the speaker and the current cue of the line the voice queue is playing.
// Shown when the player keeps subtitles on, and always when a line fell back to text (no file,
// muted voice, audio locked or failed), so a line is never lost. Drawn under the game UI layer,
// so a menu or the pause screen covers it (the queue holds the line while paused).
import type { SubtitleView } from "../audio/voice-queue.ts";

export const SUBTITLE_STYLES=`.fc-subtitles{position:fixed;left:50%;bottom:clamp(96px,16vh,160px);transform:translateX(-50%);z-index:19;max-width:min(760px,calc(100vw - 32px));padding:8px 16px;border-radius:8px;background:#050d12d9;color:#f4f5ed;font:500 17px/1.4 system-ui,sans-serif;text-align:center;text-shadow:0 1px 2px #000;pointer-events:none}.fc-subtitles[hidden]{display:none}.fc-subtitles strong{color:#9af4c3;margin-right:.45em;font-weight:700}`;

export interface MountedSubtitles {
  readonly element:HTMLElement;
  update(view:SubtitleView|null,enabled:boolean):void;
  dispose():void;
}

export function mountSubtitles(host:HTMLElement,doc:Document=host.ownerDocument):MountedSubtitles {
  const root=doc.createElement("div");root.className="fc-subtitles";root.hidden=true;root.setAttribute("role","status");root.setAttribute("aria-live","polite");
  const style=doc.createElement("style");style.textContent=SUBTITLE_STYLES;
  const speaker=doc.createElement("strong"),text=doc.createElement("span");root.append(speaker,text);host.append(style,root);
  let stamp="";
  return {element:root,update(view,enabled){
    const show=!!view&&(enabled||view.required||view.mode==="text");
    const next=show&&view?`${view.lineId}\u0001${view.text}\u0001${view.mode}`:"";
    if(next===stamp)return;stamp=next;root.hidden=!show;
    if(!show||!view)return;
    speaker.textContent=`${view.speakerName}:`;text.textContent=view.text;root.dataset.mode=view.mode;root.dataset.line=view.lineId;
  },dispose(){root.remove();style.remove();}};
}
