import { expect, it } from 'vitest';
import { CAMPAIGN_MISSIONS } from '../../../src/content/catalog.ts';
import { Action, NEUTRAL_INPUT, type SimState } from '../../../src/sim/contract.ts';
import { buildWorld, createInitialState, step } from '../../../src/sim/index.ts';
import { campaignOf, placePosition, stepOf } from '../../../src/sim/missions/runtime.ts';
const world=buildWorld([]);
function place(state:SimState,x:number,z:number,heading=0):void {
 const p=state.players.p1!;p.mode='foot';p.foot={x,y:0,z,heading,speed:0,sprint:false,vy:0,grounded:true,dodge:null};p.car.x=x+100;p.car.z=z+100;
}
it('plays every campaign objective with recorded controls and grants each completion once',()=>{
 let s=createInitialState(world,93,['p1'],{x:0,z:0,heading:0});let sequence=0;
 const command=(payload:Record<string,unknown>)=>{s=step(world,s,{},[{tick:s.tick+1,kind:'gameplay.command',playerId:'p1',payload:{...payload,sequence:++sequence}}]);};
 for(const mission of CAMPAIGN_MISSIONS){
  command({kind:'mission-start',targetId:mission.id});
  let ticks=0;
  while(campaignOf(s)!.players.p1!.status==='active'&&ticks++<18000){
   const run=campaignOf(s)!.players.p1!,current=stepOf(run)!;let actions=0;
   if(current.type==='trigger'){const p=placePosition(current.event.place);place(s,p.x,p.z);}
   if(current.type==='goto'){const p=placePosition(current.target);place(s,p.x,p.z);if(current.travel==='vehicle'){s.players.p1!.mode='vehicle';s.players.p1!.car.x=p.x;s.players.p1!.car.z=p.z;}}
   if(current.type==='form'){command({kind:'startup-define',kitId:'community'});continue;}
   if(current.type==='dialogue'){command({kind:'mission-answer',questionId:current.questions[run.question]!.id,choiceId:current.questions[run.question]!.answers[0]!.id});continue;}
   if(current.type==='objective'){
    const actor=Object.values(campaignOf(s)!.actors).find(a=>a.binding===current.objective.actor);
    if(actor){const cone=current.objective.kind==='cone';place(s,actor.x,actor.z+(cone?-6:3),cone?Math.PI:0);}
    switch(current.objective.kind){case 'watch':actions=Action.watch;break;case 'scan':actions=Action.scan;break;case 'melt':actions=Action.fire;break;case 'cone':actions=ticks%40===0?Action.cone:0;break;case 'threatAtMost':place(s,10000,10000);break;}
   }
   const combat=s.ext.combat as unknown as {players:Record<string,{water:number;cones:number}>}|undefined;
   if(actions===Action.cone && combat?.players.p1?.cones===0){const p=s.players.p1!;p.car.x=p.foot!.x;p.car.z=p.foot!.z;p.mode='vehicle';s=step(world,s,{});continue;}
   if(actions===Action.fire && (combat?.players.p1?.water??8)<1){const fountain=campaignOf(s)!.actors[Object.keys(campaignOf(s)!.actors).sort()[0]!]!;place(s,fountain.x,fountain.z);for(let refill=0;refill<240;refill++)s=step(world,s,{p1:{...NEUTRAL_INPUT,actions:Action.interact}});continue;}
   s=step(world,s,{p1:{...NEUTRAL_INPUT,actions,aimPitch:0}});
  }
  const run=campaignOf(s)!.players.p1!;
  if(run.status!=='success')console.log(JSON.stringify({mission:mission.id,run,combat:s.ext.combat}));
  expect({mission:mission.id,step:run.stepId,status:run.status},'all objectives must be completable').toMatchObject({status:'success'});
  expect(run.completed).toContain(mission.id);const cash=run.cash;command({kind:'mission-ack'});expect(campaignOf(s)!.players.p1!.cash).toBe(cash);
 }
 expect(campaignOf(s)!.players.p1!.completed).toHaveLength(10);
},60000);
