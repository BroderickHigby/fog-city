// Build-time synthesis only. Credentials never enter the client, assets, logs or git.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MISSIONS } from '../src/content/catalog.ts';
import { voiceKey } from '../src/audio/voice-files.ts';
const root=resolve(import.meta.dirname,'..');
let key=process.env.ELEVENLABS_API_KEY??process.env.ELEVEN_API_KEY??'';
for(const path of [resolve(root,'../daringly/.env.local'),resolve(root,'.env.local')]){
  if(key||!existsSync(path))continue;
  const match=readFileSync(path,'utf8').match(/^(?:export\s+)?(?:ELEVENLABS_API_KEY|ELEVEN_API_KEY)\s*=\s*["']?([^\r\n"'#]+)/m);if(match)key=match[1]!.trim();
}
const lines=new Map<string,{speaker:string;text:string}>();
for(const mission of MISSIONS)for(const step of mission.steps){
  const spoken='lines'in step?step.lines??[]:[];
  for(const line of spoken)lines.set(voiceKey(line.speaker,line.text),line);
  if(step.type==='dialogue')for(const q of step.questions){lines.set(voiceKey(step.speaker,q.prompt),{speaker:step.speaker,text:q.prompt});for(const a of q.answers)lines.set(voiceKey(step.speaker,a.reply),{speaker:step.speaker,text:a.reply});}
}
if(process.argv.includes('--check')){console.log(`${lines.size} unique dialogue lines; credential ${key?'available':'not configured'}.`);process.exit(0);}
if(!key){console.error('ElevenLabs synthesis needs ELEVENLABS_API_KEY in the process or the authorized .env.local source. Browser narration and subtitles remain available.');process.exit(2);}
const headers={'xi-api-key':key,'content-type':'application/json'};
const response=await fetch('https://api.elevenlabs.io/v1/voices',{headers});if(!response.ok)throw new Error(`Voice catalog HTTP ${response.status}`);
const data=await response.json() as {voices:Array<{voice_id:string;category:string}>};const voices=data.voices.filter(v=>['premade','default'].includes(v.category));
if(!voices.length&&!process.env.ELEVENLABS_VOICE_ID)throw new Error('Select an authorized ELEVENLABS_VOICE_ID; no stock voices available.');
const files:Record<string,string>={};mkdirSync(resolve(root,'public/audio/voices'),{recursive:true});
for(const [id,line]of lines){
 const slot=line.speaker==='dispatch'?1:line.speaker==='host'?2:0;const voice=process.env.ELEVENLABS_VOICE_ID??voices[slot%voices.length]!.voice_id;
 const path=`audio/voices/${id}.mp3`,target=resolve(root,'public',path);
 if(!existsSync(target)){
  const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,{method:'POST',headers,body:JSON.stringify({text:line.text,model_id:'eleven_multilingual_v2',voice_settings:{stability:.55,similarity_boost:.65}})});
  if(!r.ok)throw new Error(`Synthesis HTTP ${r.status}; stopped before further calls.`);
  writeFileSync(target,new Uint8Array(await r.arrayBuffer()));
 }
 files[id]=path;
}
writeFileSync(resolve(root,'src/audio/voice-files.ts'),`export const voiceFiles: Record<string,string> = ${JSON.stringify(files,null,2)};\nexport function voiceKey(speaker:string,text:string):string {let h=2166136261;for(const ch of speaker+'\\n'+text){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}\n`);
console.log(`Wrote ${Object.keys(files).length} voice assets; no credential persisted.`);
