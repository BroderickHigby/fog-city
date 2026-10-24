// Audio settings: master, music, effects and voice volume sliders with mutes, and subtitles.
// Writes through an AudioPrefsStore (persisted per browser); the mixer applies each change at
// once. Mounted in the pause screen and the phone's Settings app (mount.ts).
import type { AudioPrefs, AudioPrefsStore } from "../audio/prefs.ts";

export const AUDIO_SETTINGS_STYLES=`.fc-audio-settings{display:grid;gap:10px;min-width:min(420px,80vw)}.fc-audio-settings h2{margin:0;font-size:16px}.fc-audio-row{display:grid;grid-template-columns:7em 1fr 3.2em auto;gap:10px;align-items:center}.fc-audio-row input[type=range]{width:100%;accent-color:#9af4c3;min-height:32px}.fc-audio-row output{font-variant-numeric:tabular-nums;text-align:right}.fc-audio-row label,.fc-audio-check{display:flex;gap:6px;align-items:center}.fc-audio-check input,.fc-audio-row input[type=checkbox]{width:20px;height:20px;accent-color:#9af4c3}.fc-audio-credit{margin:0;color:#bcd1d4;font-size:12px}`;

type Channel="master"|"music"|"effects"|"voice";
const CHANNELS:readonly {key:Channel;label:string;mute:"masterMuted"|"musicMuted"|"effectsMuted"|"voiceMuted"}[]=[
  {key:"master",label:"Master",mute:"masterMuted"},{key:"music",label:"Music",mute:"musicMuted"},
  {key:"effects",label:"Effects",mute:"effectsMuted"},{key:"voice",label:"Voices",mute:"voiceMuted"},
];

export interface AudioSettingsOptions {
  readonly store:AudioPrefsStore;
  /** Car radio stations for the station picker (radio.ts). */
  readonly stations?:readonly {id:string;name:string}[];
  /** "Now playing" credit for the current track (CC0 attribution, as a courtesy). */
  readonly nowPlaying?:()=>string|null;
}

export function mountAudioSettings(doc:Document,options:AudioSettingsOptions):{element:HTMLElement;dispose():void} {
  const root=doc.createElement("section");root.className="fc-audio-settings";root.setAttribute("aria-label","Audio settings");
  const style=doc.createElement("style");style.textContent=AUDIO_SETTINGS_STYLES;
  const title=doc.createElement("h2");title.textContent="Audio";root.append(style,title);
  const inputs=new Map<Channel,{range:HTMLInputElement;out:HTMLOutputElement;mute:HTMLInputElement}>();
  for(const channel of CHANNELS){
    const row=doc.createElement("div");row.className="fc-audio-row";
    const id=`fc-audio-${channel.key}`,name=doc.createElement("label");name.htmlFor=id;name.textContent=channel.label;
    const range=doc.createElement("input");range.type="range";range.id=id;range.min="0";range.max="100";range.step="1";range.setAttribute("aria-label",`${channel.label} volume`);
    const out=doc.createElement("output");out.htmlFor.add(id);
    const muteLabel=doc.createElement("label"),mute=doc.createElement("input");mute.type="checkbox";mute.setAttribute("aria-label",`Mute ${channel.label.toLowerCase()}`);muteLabel.append(mute,doc.createTextNode("Mute"));
    range.addEventListener("input",()=>options.store.set({[channel.key]:Number(range.value)/100}));
    mute.addEventListener("change",()=>options.store.set({[channel.mute]:mute.checked}));
    row.append(name,range,out,muteLabel);root.append(row);inputs.set(channel.key,{range,out,mute});
  }
  const subtitlesLabel=doc.createElement("label");subtitlesLabel.className="fc-audio-check";
  const subtitles=doc.createElement("input");subtitles.type="checkbox";subtitles.setAttribute("aria-label","Show subtitles");
  subtitles.addEventListener("change",()=>options.store.set({subtitles:subtitles.checked}));
  subtitlesLabel.append(subtitles,doc.createTextNode("Subtitles (lines without audio always show)"));root.append(subtitlesLabel);
  let station:HTMLSelectElement|undefined;
  if(options.stations?.length){
    const row=doc.createElement("label");row.className="fc-audio-check";row.textContent="Car radio (M / Shift+M) ";
    station=doc.createElement("select");station.setAttribute("aria-label","Car radio station");
    for(const s of options.stations){const o=doc.createElement("option");o.value=s.id;o.textContent=s.name;station.append(o);}
    const picker=station;picker.addEventListener("change",()=>options.store.set({station:picker.value}));row.append(picker);root.append(row);
  }
  const credit=doc.createElement("p");credit.className="fc-audio-credit";root.append(credit);
  const show=(prefs:AudioPrefs):void=>{
    for(const channel of CHANNELS){const i=inputs.get(channel.key)!,value=Math.round(prefs[channel.key]*100);if(doc.activeElement!==i.range)i.range.value=String(value);i.out.value=`${value}%`;i.mute.checked=prefs[channel.mute];i.range.disabled=prefs[channel.mute];}
    subtitles.checked=prefs.subtitles;if(station)station.value=prefs.station;
    const playing=options.nowPlaying?.();credit.textContent=playing?`Now playing: ${playing}`:"";credit.hidden=!playing;
  };
  show(options.store.get());
  const unsubscribe=options.store.subscribe(show);
  return {element:root,dispose(){unsubscribe();root.remove();}};
}
