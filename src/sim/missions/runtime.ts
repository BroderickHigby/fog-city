import { MISSIONS } from '../../content/catalog.ts';
import type { Mission, Step, Place, Line } from '../../content/missions.ts';
import { toLocal } from '../../geo/project.ts';
import { Action, DT, sortedIds, type SimState } from '../contract.ts';
import { gameplayCommandFromEvent } from '../gameplay-contract.ts';
import type { SimSystem, SimSystemContext } from '../system-contract.ts';
import { groundHeight, groundWater, nearbyBuildings, pointInPolygon, type World } from '../world.ts';
import { contextFromState } from '../combat/adapter.ts';
import { createCombatSystem } from '../combat/systems.ts';
import { combatOf } from '../combat/system.ts';
import type { CombatActor } from '../combat/types.ts';
import { createRobotBrain, stepRobotBrain, type RobotBrainState } from '../robots/brain.ts';
import { dcos, dsin, datan2 } from '../dmath.ts';

export interface MissionBody extends CombatActor { owner: string; binding: string; brain?: RobotBrainState; attack?: import("../combat/types.ts").AttackRequest }
export interface MissionRun {
  missionId: string; stepId: string; entered: number; question: number; watchTicks: number;
  cash: number; completed: string[]; unlocks: string[]; meters: Record<string, number>;
  sequence: number; status: 'active' | 'success' | 'retry'; line: Line | null;
  threat: number; unseenTicks: number; counted: string[]; reply: string;
}
export interface CampaignState { players: Record<string, MissionRun>; actors: Record<string, MissionBody> }
export const campaignOf = (s: Readonly<SimState>): CampaignState | undefined => s.ext.missions as unknown as CampaignState | undefined;
export const missionOf = (run: MissionRun): Mission | undefined => MISSIONS.find(m => m.id === run.missionId);
export const stepOf = (run: MissionRun): Step | undefined => missionOf(run)?.steps.find(s => s.id === run.stepId);
const values = <T>(record: Readonly<Record<string,T>>): T[] => sortedIds(record).map(id=>record[id]!);
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
export const placePosition = (p: Place) => toLocal(p.lat, p.lon);
const body = (s: Readonly<SimState>, id: string) => s.players[id]?.mode === 'foot' ? s.players[id]!.foot! : s.players[id]?.car;

function enter(run: MissionRun, id: string, tick: number): void {
  run.stepId = id; run.entered = tick; run.question = 0; run.watchTicks = 0; run.reply = '';
  const step = stepOf(run);
  if (step && 'lines' in step && step.lines?.length) run.line = step.lines[0]!;
}
function safeSpot(world: World, x: number, z: number): {x:number;y:number;z:number} {
  for (let i = 0; i < 64; i++) {
    const r = i === 0 ? 0 : 2 + i * 0.5, a = i * 2.399963;
    const px = x + dsin(a) * r, pz = z + dcos(a) * r;
    if (groundWater(world,px,pz)) continue;
    const y = groundHeight(world, px, pz);
    if (nearbyBuildings(world, px, pz, 1).some(b => b.topY > y + 0.5 && pointInPolygon(px,pz,b.footprint))) continue;
    return { x:px,y,z:pz };
  }
  return {x,y:groundHeight(world,x,z),z};
}
function stage(campaign: CampaignState, run: MissionRun, owner: string, step: Extract<Step,{type:'stage'}>, world: World): void {
  const mission = missionOf(run)!; const at = placePosition(step.place);
  for (const binding of step.actors) {
    const definition = mission.actors?.[binding]; if (!definition) continue;
    const members = definition.kind === 'crew' ? definition.members ?? [] : [definition.archetype ?? binding];
    members.forEach((name, i) => {
      const id = `${owner}:${run.missionId}:${run.sequence}:${binding}${members.length > 1 ? ':'+i : ''}`;
      if (campaign.actors[id]) return;
      const n = Object.keys(campaign.actors).length;
      const p = safeSpot(world,at.x + (n % 3 - 1)*5,at.z + 3 + Math.floor(n/3)*5);
      campaign.actors[id] = {id,owner,binding,...p,heading:0,speed:0,radius:0.45,height:1.8,kind:'robot',firmware:definition.kind.startsWith('good')?'good':'bad',model:name.toLowerCase().includes('trundle')?'trundle':definition.kind.toLowerCase().includes('taxi')?'robotaxi':'footman',obeysTraffic:true,subtlety:1,protected:false};
    });
  }
}
function target(c: CampaignState,id:string,binding:string|undefined): MissionBody | undefined {
  return values(c.actors).find(a=>a.owner===id && a.binding===binding);
}
function missionSystem(ctx: SimSystemContext): SimState {
  const previous = campaignOf(ctx.state);
  const commands = ctx.events.map(gameplayCommandFromEvent).filter(c=>c!==null);
  if (!previous && !commands.some(c=>c.kind==='mission-start')) return ctx.state;
  const c: CampaignState = {players:{},actors:{...previous?.actors}};
  for (const id of sortedIds(previous?.players??{})) {const r=previous!.players[id]!; c.players[id]={...r,meters:{...r.meters},completed:[...r.completed],unlocks:[...r.unlocks],counted:[...r.counted]};}
  for (const command of commands) {
    if (!ctx.state.players[command.playerId]) continue;
    let r=c.players[command.playerId];
    if (r && command.sequence<=r.sequence) continue;
    if (command.kind==='mission-start') {
      const m=MISSIONS.find(m=>m.id===command.targetId); if (!m) continue;
      const prior=m.campaign && m.campaign>1 ? MISSIONS.find(p=>p.campaign===m.campaign!-1) : undefined;
      if (prior && !r?.completed.includes(prior.id)) continue;
      if (r?.status==='active') continue;
      for(const key of sortedIds(c.actors)) if(c.actors[key]!.owner===command.playerId) delete c.actors[key];
      r={missionId:m.id,stepId:m.start??m.steps[0]!.id,entered:ctx.state.tick,question:0,watchTicks:0,cash:r?.cash??0,completed:r?.completed??[],unlocks:r?.unlocks??[],meters:Object.fromEntries(sortedIds(m.meters).map(k=>[k,m.meters[k]!.start])),sequence:command.sequence,status:'active',line:null,threat:0,unseenTicks:0,counted:[],reply:''};
      c.players[command.playerId]=r; enter(r,r.stepId,ctx.state.tick);
    } else if (r) {
      r.sequence=command.sequence; const s=stepOf(r); if(!s) continue;
      if(command.kind==='mission-retry' && s.type==='retry' && ctx.state.tick-r.entered >= (s.cooldownS??0)/DT) {for(const key of sortedIds(c.actors))if(c.actors[key]!.owner===command.playerId)delete c.actors[key];r.counted=[];r.threat=0;r.status='active';enter(r,s.retryFrom,ctx.state.tick);}
      if(command.kind==='mission-answer' && s.type==='dialogue') {
        const q=s.questions[r.question];const a=q?.answers.find(a=>a.id===command.choiceId); const m=missionOf(r)!.meters[s.meter];
        if(a && q?.id===command.questionId && m) {r.meters[s.meter]=Math.max(m.min,Math.min(m.max,(r.meters[s.meter]??m.start)+a.delta));r.reply=a.reply;r.question++;if(r.question>=s.questions.length) enter(r,s.next,ctx.state.tick);}
      }
      if(command.kind==='startup-define' && s.type==='form' && ['mobility','climate','community'].includes(command.kitId??'')) {if(!r.unlocks.includes('startup:'+command.kitId))r.unlocks.push('startup:'+command.kitId); enter(r,s.next,ctx.state.tick);}
      if(command.kind==='mission-ack' && s.type==='timer' && ctx.state.tick-r.entered>=s.durationS/DT) enter(r,s.next,ctx.state.tick);
    }
  }
  const combat=combatOf(ctx.state);
  for(const key of sortedIds(c.actors)){
    const old=c.actors[key]!,p=body(ctx.state,old.owner);
    if(!p){delete c.actors[key];continue;}
    if(c.players[old.owner]?.status!=='active'){c.actors[key]={...old,speed:0};delete c.actors[key]!.attack;continue;}
    if(old.firmware!=='bad'||old.model==='robotaxi'||combat?.targets[key]?.phase && combat.targets[key]!.phase!=='active')continue;
    const actor={...old};delete actor.attack;
    const input=ctx.inputs[actor.owner],distance=dist(actor,p);
    const visible=distance<30 && !nearbyBuildings(ctx.world,(actor.x+p.x)/2,(actor.z+p.z)/2,distance/2+1).some(b=>{
      for(let i=1;i<8;i++)if(pointInPolygon(actor.x+(p.x-actor.x)*i/8,actor.z+(p.z-actor.z)*i/8,b.footprint)&&b.topY>actor.y+1)return true;return false;
    });
    const brain=stepRobotBrain(actor.brain??createRobotBrain({id:sortedIds(c.actors).indexOf(key)+1,tick:ctx.state.tick}),{
      tick:ctx.state.tick,self:{x:actor.x,z:actor.z,heading:actor.heading,rust:combat?.targets[key]?.rust??0,fogDensity:0,shoved:false},
      observations:{sight:[{kind:'player',id:actor.owner,x:p.x,z:p.z,heading:p.heading,inVehicle:ctx.state.players[actor.owner]!.mode==='vehicle',threatening:!!((input?.actions??0)&Action.fire),lineOfSight:visible}],sounds:(input?.actions??0)&Action.fire?[{kind:'spray',playerId:actor.owner,x:p.x,z:p.z}]:[],broadcasts:[],scans:[],watches:(input?.actions??0)&Action.watch?[{playerId:actor.owner,x:p.x,z:p.z,lineOfSight:visible}]:[]},
      conversion:{withinFidelity:distance<60,protectedArea:false,baseBadCount:1,badCount:1},meleeSlotsAvailable:0,goalWeights:{adBlast:5,phoneHack:3,shove:0,handshake:0,grocerySnatch:0,forcedUpdate:0}
    });
    actor.brain=brain.state;
    const motion=brain.intent.movement;
    if(motion.kind==='pursue'&&distance>motion.stopDistance+1 && distance<50){const dx=motion.destination.x-actor.x,dz=motion.destination.z-actor.z,d=Math.sqrt(dx*dx+dz*dz)||1;const next=safeSpot(ctx.world,actor.x+dx/d*.025,actor.z+dz/d*.025);if(dist(actor,next)<.1){actor.x=next.x;actor.y=next.y;actor.z=next.z;actor.heading=datan2(dx,-dz);actor.speed=1.5;}}
    if(brain.intent.action.kind==='attack'&&brain.intent.action.target.kind==='player')actor.attack={id:key+':'+ctx.state.tick,sequence:ctx.state.tick,attackerId:key,targetId:actor.owner,kind:brain.intent.action.attack==='phoneHack'?'phone-hack':'ad-blast'};
    c.actors[key]=actor;
  }
  for(const id of sortedIds(c.players)) {
    const r=c.players[id]!, p=body(ctx.state,id); if(!p) {delete c.players[id];continue;} if(r.status!=='active')continue;
    const input=ctx.inputs[id];
    const owned=values(c.actors).filter(a=>a.owner===id);
    const fresh=owned.filter(a=>a.firmware==='bad' && combat?.targets[a.id]?.phase==='heap' && !r.counted.includes(a.id));
    for(const a of fresh)r.counted.push(a.id);
    if(fresh.length)r.threat=Math.min(5,r.threat+2*fresh.length);
    const seen=owned.some(a=>a.firmware==='bad' && dist(a,p)<25 && (!combat?.targets[a.id] || combat.targets[a.id]!.phase==='active'));
    r.unseenTicks=seen?0:r.unseenTicks+1;
    if(r.unseenTicks>=1800){r.threat=Math.max(0,r.threat-1);r.unseenTicks=0;}
    // Bound automatic graph transitions; malformed cycles cannot stall the simulation.
    for(let hop=0;hop<12;hop++) {
      const s=stepOf(r); if(!s)break;
      let next:string|undefined;
      if(s.type==='trigger') {if(s.event.kind==='phoneCall' || dist(p,placePosition(s.event.place))<=(s.event.place.radiusM??50))next=s.next;}
      else if(s.type==='stage'){stage(c,r,id,s,ctx.world);next=s.next;}
      else if(s.type==='goto'){if(dist(p,placePosition(s.target))<=s.target.radiusM && (s.travel!=='foot'||ctx.state.players[id]!.mode==='foot') && (s.travel!=='vehicle'||ctx.state.players[id]!.mode==='vehicle'))next=s.next;else if(ctx.state.tick-r.entered>=s.timer.limitS/DT)next=s.onTimeout;}
      else if(s.type==='timer'){if(ctx.state.tick-r.entered>=s.durationS/DT)next=s.next;}
      else if(s.type==='branch'){const value=r.meters[s.meter]??0; next=s.cases.find(v=>(v.min===undefined||value>=v.min)&&(v.max===undefined||value<=v.max))?.next??s.default;}
      else if(s.type==='objective') {
        const a=target(c,id,s.objective.actor), t=a?combat?.targets[a.id]:undefined;
        const watchYaw=input?.aimYaw??p.heading;
        const inReach=a && dist(p,a)<=30 && !nearbyBuildings(ctx.world,(p.x+a.x)/2,(p.z+a.z)/2,dist(p,a)/2+1).some(b=>{
          for(let sample=1;sample<16;sample++)if(pointInPolygon(p.x+(a.x-p.x)*sample/16,p.z+(a.z-p.z)*sample/16,b.footprint)&&b.topY>Math.min(p.y,a.y)+1)return true;return false;
        }) && ((a.x-p.x)*dsin(watchYaw)-(a.z-p.z)*dcos(watchYaw))>=dist(p,a)*.5;
        const cp=combat?.players[id];let done=false;
        switch(s.objective.kind){
          case 'watch': r.watchTicks=inReach && (input?.actions??0)&Action.watch ? r.watchTicks+1:0;done=r.watchTicks>=(s.objective.seconds??3)/DT;break;
          case 'scan': done=!!a && cp?.scan?.targetId===a.id && cp.scan.tick>=r.entered;break;
          case 'melt': done=!!t && (t.phase==='heap'||t.phase==='cleared');break;
          case 'cone': done=!!t && t.pullOverTick>=r.entered && t.pullOverTick>0;break;
          case 'refill': done=(cp?.water??0)>=7.9;break;
          case 'enterVehicle': done=ctx.state.players[id]!.mode==='vehicle';break;
          case 'threatAtLeast': done=r.threat>=(s.objective.level??1);break;
          case 'threatAtMost': done=r.threat<=(s.objective.level??0);break;
          case 'interruptUpdate': done=combat?.events.some(e=>e.kind.includes('interrupt') && e.tick>=r.entered)??false;break;
        }
        if(done)next=s.next;else if(s.timeLimitS && ctx.state.tick-r.entered>=s.timeLimitS/DT)next=s.onFail;
      } else if(s.type==='reward') {
        // Completion is a terminal state: repeat commands cannot grant money twice.
        if(!r.completed.includes(r.missionId)){r.completed.push(r.missionId);for(const grant of s.grants){if(grant.kind==='stat'&&grant.stat==='cash')r.cash+=grant.delta;if(grant.kind==='unlock'&&!r.unlocks.includes(grant.unlock))r.unlocks.push(grant.unlock);}}
        r.status='success';r.line=s.lines?.[0]??r.line;
      } else if(s.type==='retry'){r.status='retry';r.line=s.lines?.[0]??r.line;}
      else if(s.type==='end'){r.status=missionOf(r)!.outcomes[s.outcome]?.kind==='success'?'success':'retry';if(r.status==='success'&&!r.completed.includes(r.missionId))r.completed.push(r.missionId);}
      if(!next)break;enter(r,next,ctx.state.tick);
    }
  }
  return {...ctx.state,ext:{...ctx.state.ext,missions:c as unknown as import('../extensions.ts').JsonObject}};
}
const combatSystem=createCombatSystem(ctx=>{
  const c=campaignOf(ctx.state);
  const refills=ctx.world.gameplay?.refills??values(c?.players??{}).map((r,i)=>{const s=stepOf(r);const actor=values(c?.actors??{}).find(a=>a.owner===sortedIds(c?.players??{})[i]);const p=s?.type==='stage'?placePosition(s.place):actor??{x:0,z:0};return {id:'fountain:'+i,...p,y:groundHeight(ctx.world,p.x,p.z),kind:'fountain' as const,radius:8,salt:false};});
  return {context:contextFromState(ctx.world,ctx.state,{extraActors:values(c?.actors??{}),refills,attacks:values(c?.actors??{}).flatMap(a=>a.attack?[a.attack]:[])})};
});
export const campaignSystems: readonly SimSystem[]=[{key:'combat',step:ctx=>campaignOf(ctx.state)?combatSystem.step(ctx):ctx.state},{key:'missions',step:missionSystem}];
