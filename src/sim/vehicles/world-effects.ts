import { DAY_TICKS, gameTime } from "../clock/calendar.ts";
import { FOOT, makeFoot } from "../foot.ts";
import { CAR } from "../car.ts";
import { dcos, dsin } from "../dmath.ts";
import { agentCircles } from "../agents.ts";
import { boxDistance } from "../dodge.ts";
import { circleBlockedBand, meshGroundHeight } from "../world.ts";
import { circleHitsWall, segmentCrossesWall } from "../boundary.ts";
import type { SimState } from "../contract.ts";
import { isMatchInstance } from "../player/adapter.ts";
import type { GameplaySite } from "../player/types.ts";
import type { SimSystem } from "../system-contract.ts";

export interface WorldEffectsState {
  version: 1;
  playerCursor: number;
  economyCursor: number;
}

export interface WorldEffectsOptions { sites: readonly GameplaySite[]; wave: number }

function fresh(): WorldEffectsState { return { version: 1, playerCursor: 0, economyCursor: 0 }; }

/** The placement is accepted before the ordinary movement and final clearance phases. */
function respawn(state: SimState, world: Parameters<NonNullable<SimSystem["prepare"]>>[0]["world"], playerId: string, site: GameplaySite): SimState {
  const player=state.players[playerId];
  if(!player)return state;
  for(let ring=0;ring<=16;ring++)for(let angle=0;angle<(ring===0?1:16);angle++){
    const heading=angle*Math.PI/8,x=site.x+dsin(heading)*ring*2,z=site.z-dcos(heading)*ring*2,y=meshGroundHeight(world,x,z);
    if(circleBlockedBand(world,x,z,FOOT.radius,y+.05,y+FOOT.height)||circleHitsWall(world.walls,x,z,FOOT.radius)
      ||segmentCrossesWall(world.walls,site.x,site.z,x,z))continue;
    let blocked=false;
    for(const id of Object.keys(state.players).sort()){
      const other=state.players[id]!,car=other.car;
      if(y<car.y+CAR.bodyHeight+.1&&car.y<y+FOOT.height&&boxDistance(x,z,car.x,car.z,dsin(car.heading),-dcos(car.heading),CAR.halfLength,CAR.halfWidth)<FOOT.radius+.1)blocked=true;
      if(id!==playerId&&other.mode==="foot"&&other.foot){const foot=other.foot,dx=x-foot.x,dz=z-foot.z;if(y<foot.y+FOOT.height&&foot.y<y+FOOT.height&&dx*dx+dz*dz<(2*FOOT.radius+.1)*(2*FOOT.radius+.1))blocked=true;}
    }
    for(const body of state.ext.agents?.list??[]){
      if(y>=body.y+(body.height??1.8)||body.y>=y+FOOT.height)continue;
      for(const circle of agentCircles(body)){const dx=x-circle.x,dz=z-circle.z;if(dx*dx+dz*dz<(FOOT.radius+circle.r+.1)*(FOOT.radius+circle.r+.1))blocked=true;}
    }
    if(!blocked)return {...state,players:{...state.players,[playerId]:{...player,mode:"foot",foot:makeFoot(x,y,z,player.car.heading),exitPending:false}}};
  }
  return state;
}

/** Consume owner-validated recovery and sleep events exactly once; never derive rewards here. */
export function createWorldEffectsSystem(options: WorldEffectsOptions): SimSystem {
  return {key:"vehicles",prepare(context){
    if(isMatchInstance(context.state))return {state:context.state,motions:[]};
    const previous={...fresh(),...context.state.ext.vehicles};
    const own={...previous};
    let state=context.state,advance=0;
    const playerEvents=(state.ext.player?.events??[]).filter(event=>event.id>own.playerCursor).sort((a,b)=>a.id-b.id);
    const acquired=new Set(playerEvents.filter(event=>event.kind==="player.acqui-hired").map(event=>event.playerId));
    for(const event of playerEvents){
      own.playerCursor=event.id;
      if(event.kind!=="player.respawn")continue;
      const target=acquired.has(event.playerId)?"fidi-desk":event.targetId;
      const site=options.sites.find(candidate=>candidate.id===target&&candidate.kind==="safehouse"&&candidate.wave<=options.wave);
      if(site)state=respawn(state,context.world,event.playerId,site);
    }
    const economyEvents=(state.ext.economy?.events??[]).filter(event=>event.id>own.economyCursor).sort((a,b)=>a.id-b.id);
    for(const event of economyEvents){
      own.economyCursor=event.id;
      if(event.kind==="player.slept"&&Number.isFinite(event.amount)&&event.amount>0)advance=Math.max(advance,Math.min(24,event.amount)*3600);
    }
    if(acquired.size){const calendar=gameTime(state),time=calendar.hour*3600+calendar.minute*60+calendar.second;advance=Math.max(advance,(8*3600-time+DAY_TICKS)%DAY_TICKS||DAY_TICKS);}
    const elapsed=(state.ext.clock?.elapsedTicks??context.previous.tick)+Math.round(advance);
    return {state:{...state,ext:{...state.ext,vehicles:own,...(advance?{clock:{version:1 as const,elapsedTicks:elapsed}}:{})}},motions:[]};
  },step:context=>context.state};
}
