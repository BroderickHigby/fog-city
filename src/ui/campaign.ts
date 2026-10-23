import { CAMPAIGN_MISSIONS } from '../content/catalog.ts';
import type { SimState } from '../sim/contract.ts';
import { campaignOf, missionOf, placePosition, stepOf } from '../sim/missions/runtime.ts';
import { combatOf } from '../sim/combat/system.ts';
import type { GameplayCommandPayload } from '../sim/gameplay-contract.ts';
import type { AudioDirector } from '../audio/director.ts';
export class CampaignHud {
  private panel=document.createElement('section');private title=document.createElement('h2');private detail=document.createElement('p');private subtitle=document.createElement('p');private actions=document.createElement('div');private status=document.createElement('div');private speed=document.createElement('div');private last='';private sequence=0;private previous=0;
  private send:(command:GameplayCommandPayload)=>void; private audio:AudioDirector;
  constructor(send:(command:GameplayCommandPayload)=>void,audio:AudioDirector){this.send=send;this.audio=audio;
    const style=document.createElement('style');style.textContent=`#campaign{position:fixed;left:28px;top:64px;z-index:4;width:min(360px,calc(100vw - 56px));box-sizing:border-box;padding:20px 22px;color:#edf8f5;background:linear-gradient(135deg,#102225ed,#101922ed);border:1px solid #92d1bc44;border-left:3px solid #90e5c7;box-shadow:0 16px 60px #0005;backdrop-filter:blur(18px);font:14px/1.45 system-ui;border-radius:4px 16px 16px 4px}#campaign .eyebrow{letter-spacing:3px;font-size:10px;font-weight:800;color:#91dcbf;text-transform:uppercase}#campaign h2{font-size:25px;line-height:1.1;margin:10px 0}#campaign p{margin:10px 0;color:#c7dad6}#campaign .subtitle{font-size:13px;color:#f0edcf}#campaign button{display:block;width:100%;text-align:left;background:#d7f3e8;color:#132e28;border:0;border-radius:7px;padding:10px 12px;margin-top:8px;font:600 13px system-ui;cursor:pointer}#campaign button:disabled{opacity:.45;cursor:default}#campaign button:hover:enabled{background:#aaf7db}#campaign .mission-status{font:11px/1.5 ui-monospace,monospace;color:#82bea9;white-space:pre-line}#drive-speed{position:fixed;right:28px;bottom:30px;z-index:3;color:white;font:500 44px/1 system-ui;text-shadow:0 2px 15px #0008;letter-spacing:-2px}#drive-speed small{display:block;font:11px/1.8 system-ui;letter-spacing:2px;text-align:right}#radio{position:fixed;right:26px;top:66px;z-index:5;border:1px solid #b5dbce55;background:#102025c9;color:#c9e9de;font:11px system-ui;padding:9px 13px;border-radius:20px;cursor:pointer}#campaign .controls{font-size:10px;color:#9eafa8;margin-top:13px}@media(max-width:650px){#campaign{left:12px;top:58px;padding:13px 16px;width:280px}#campaign h2{font-size:20px}#drive-speed{right:16px;bottom:20px;font-size:30px}}`;document.head.append(style);
    this.panel.id='campaign';this.panel.setAttribute('aria-label','Mission');const label=document.createElement('div');label.className='eyebrow';label.textContent='Fog City / Founder Stories';this.subtitle.className='subtitle';this.status.className='mission-status';const controls=document.createElement('div');controls.className='controls';controls.textContent='WASD move · F enter / exit · hold E spray · Q scan · R watch · G cone · T refill';this.panel.append(label,this.title,this.detail,this.subtitle,this.actions,this.status,controls);document.body.append(this.panel);this.speed.id='drive-speed';document.body.append(this.speed);
    for(const name of ['keydown','keyup'])this.panel.addEventListener(name,e=>e.stopPropagation());
    const radio=document.createElement('button');radio.id='radio';radio.textContent='▶ Neon Tide · Radio off';let on=false;radio.onclick=()=>{radio.blur();on=!on;if(on)void this.audio.start();this.audio.setMuted(!on);radio.textContent=on?'♫ Neon Tide · Radio on':'▶ Neon Tide · Radio off';};document.body.append(radio);
  }
  private button(text:string,kind:GameplayCommandPayload['kind'],extra:Partial<GameplayCommandPayload>={}):void{const b=document.createElement('button');b.textContent=text;b.onclick=()=>{b.blur();this.send({sequence:++this.sequence,kind,...extra});};this.actions.append(b);}
  update(state:SimState,id:string,online:boolean):void{
    if(state.tick-this.previous<8&&state.tick>=this.previous)return;this.previous=state.tick;
    const run=campaignOf(state)?.players[id],step=run?stepOf(run):undefined,mission=run?missionOf(run):undefined;
    if(run)this.sequence=Math.max(this.sequence,run.sequence);
    const player=state.players[id],body=player?.mode==='foot'?player.foot:player?.car;
    this.speed.replaceChildren(document.createTextNode(`${Math.round(Math.abs(body?.speed??0)*3.6)}`));const unit=document.createElement('small');unit.textContent=player?.mode==='foot'?'ON FOOT':'KM/H';this.speed.append(unit);
    const key=[run?.missionId,run?.stepId,run?.question,run?.status,online].join(':');
    if(key!==this.last){this.last=key;this.actions.replaceChildren();
      this.title.textContent=mission?.title??'Welcome to San Francisco';
      if(online){this.detail.textContent='Free roam with friends. Campaign missions resume in solo play.';}
      else if(!run){this.detail.textContent='A car, a water blaster, and eighteen months of runway. Your first day starts by the Ferry Building.';this.button('Start Hot Desk →','mission-start',{targetId:'hot-desk'});}
      else if(run.status==='success'){this.detail.textContent='Mission complete. The next call is waiting.';const next=CAMPAIGN_MISSIONS.find(m=>m.campaign===(mission?.campaign??0)+1);if(next)this.button(`Next: ${next.title} →`,'mission-start',{targetId:next.id});else this.detail.textContent='Campaign complete. The city is yours — take the scenic route.';}
      else if(run.status==='retry'){this.detail.textContent='Missed the window? Every founder gets another shot.';this.button('Try again →','mission-retry');}
      else if(step?.type==='dialogue'){const q=step.questions[run.question];this.detail.textContent=q?.prompt??'';for(const a of q?.answers??[])this.button(a.text,'mission-answer',{questionId:q!.id,choiceId:a.id});}
      else if(step?.type==='form'){this.detail.textContent=step.form.prompt;for(const [kit,label]of [['mobility','Help people get around'],['climate','Build a cleaner city'],['community','Bring the neighborhood together']])this.button(label!,'startup-define',{kitId:kit!});}
      else {this.detail.textContent=step?.type==='trigger'?`Head to ${step.event.place.label}`:step?.type==='goto'?`Head to ${step.target.label}`:step?.type==='objective'?step.hint??'Complete the objective.':mission?.summary??'';}
    }
    this.subtitle.textContent=run?.line?`${mission?.cast[run.line.speaker]?.name??run.line.speaker}: “${run.line.text}”`:'';
    if(step?.type==='dialogue' && run && step.questions[run.question])void this.audio.speak(step.speaker,step.questions[run.question]!.prompt);
    else if(run?.line)void this.audio.speak(run.line.speaker,run.line.text);
    this.audio.setThreat(run?.threat??0);
    let distance='';const goal=step?.type==='goto'?placePosition(step.target):step?.type==='trigger'?placePosition(step.event.place):undefined;if(goal&&body)distance=` · ${Math.round(Math.hypot(body.x-goal.x,body.z-goal.z))} m`;
    const remaining=step?.type==='goto'&&run?Math.max(0,Math.ceil(step.timer.limitS-(state.tick-run.entered)/60)):null;
    const water=combatOf(state)?.players[id]?.water;
    this.status.textContent=`$${run?.cash??0} · ${(run?.completed.length??0)}/10 contracts${distance}${remaining!==null?' · '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0'):''}\n${water===undefined?'':`Water ${water.toFixed(1)} L · `}Threat ${'●'.repeat(run?.threat??0)}${'○'.repeat(5-(run?.threat??0))}`;
  }
}
