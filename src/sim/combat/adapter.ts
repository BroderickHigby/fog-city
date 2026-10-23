import { AGENT_SPEC, agentsOf } from "../agents.ts";
import type { SimState } from "../contract.ts";
import { groundHeight, nearbyBuildings, type World } from "../world.ts";
import { sortedIds } from "../contract.ts";
import type { CombatActor, CombatContext, CombatPlayer, Wall } from "./types.ts";

export type CombatActorMetadata = Partial<Omit<CombatActor,"id"|"playerId"|"x"|"y"|"z"|"heading"|"speed">>;

export interface CombatAdapterOptions extends Partial<Omit<CombatContext,"actors"|"players"|"walls"|"groundHeight">> {
  /** Explicit agent metadata from the actor lane. Unclassified people stay protected. */
  actorMetadata?: Readonly<Record<string,CombatActorMetadata>>;
  loadouts?: Readonly<Record<string,Partial<CombatPlayer>>>;
  extraActors?: readonly CombatActor[];
  walls?: readonly Wall[];
}

const METADATA_FIELDS = ["kind","radius","height","firmware","model","robotBody","child","protected","posture","mobilityAid","subtlety","obeysTraffic","occupied","sheltered","pursuing","inFidelity","rustScale","fog"] as const;

/** Copy only descriptive fields; never clone and delete authoritative body fields. */
function actorMetadata(options: CombatAdapterOptions, id: string): CombatActorMetadata {
  const source=options.actorMetadata?.[id] as Readonly<Record<string,unknown>>|undefined;
  if(!source)return {};
  const metadata:Record<string,unknown>={};
  for(const field of METADATA_FIELDS)if(Object.hasOwn(source,field)&&source[field]!==undefined)metadata[field]=source[field];
  return metadata as CombatActorMetadata;
}

/**
 * Compatibility bridge for the current wave-1 actors. This does not register a system
 * or invent bad firmware. The actor lane supplies classifications and the core lane
 * calls the reducer after movement. Missing protection metadata always fails closed.
 */
export function contextFromState(world:World,state:Readonly<SimState>,options:CombatAdapterOptions={}):CombatContext {
  const players:CombatPlayer[]=sortedIds(state.players).map(id=> {
    const owner=state.players[id]!;
    const body=owner.mode==="foot" && owner.foot ? owner.foot : owner.car;
    return {tankTier:0,flowTier:0,scannerTier:1,...options.loadouts?.[id],id,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:body.speed,mount:owner.mode==="foot"?"foot":"vehicle"};
  });
  const actors:CombatActor[]=agentsOf(state).map(agent=> {
    const id=`agent:${agent.id}`, spec=AGENT_SPEC[agent.kind], person=agent.kind==="person";
    return {kind:person?"person":"robot",firmware:person?"none":"good",model:agent.kind==="robotaxi"?"robotaxi":agent.kind==="sidewalkBot"?"trundle":"footman",radius:spec.radius,height:agent.kind==="sidewalkBot"?0.7:1.8,protected:person,obeysTraffic:agent.kind==="robotaxi",...actorMetadata(options,id),id,x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:agent.speed};
  });
  for (const player of players) {
    const id=`player:${player.id}`;
    actors.push({kind:"player",firmware:"none",robotBody:false,radius:0.35,height:1.8,...actorMetadata(options,id),id,playerId:player.id,x:player.x,y:player.y,z:player.z,heading:player.heading,speed:player.speed});
  }
  actors.push(...(options.extraActors??[]));
  const walls:Wall[]=[...(options.walls??[])];
  const seen=new Set(walls.map(wall=>wall.id));
  for (const player of players) for (const building of nearbyBuildings(world,player.x,player.z,40)) {
    if (seen.has(building.id)) continue;
    seen.add(building.id);
    walls.push({id:building.id,minX:Math.min(...building.footprint.map(p=>p[0])),maxX:Math.max(...building.footprint.map(p=>p[0])),minY:building.baseY,maxY:building.topY,minZ:Math.min(...building.footprint.map(p=>p[1])),maxZ:Math.max(...building.footprint.map(p=>p[1])),footprint:building.footprint});
  }
  return {wave:options.wave??2,actors,players,walls,refills:options.refills??[],groundHeight:(x,z)=>groundHeight(world,x,z),
    ...(options.attacks?{attacks:options.attacks}:{}),...(options.conversionCap!==undefined?{conversionCap:options.conversionCap}:{}),
    ...(options.fog!==undefined?{fog:options.fog}:{}),...(options.rain!==undefined?{rain:options.rain}:{}),...(options.night!==undefined?{night:options.night}:{}),
    ...(options.mode?{mode:options.mode}:{}),...(options.safeLots?{safeLots:options.safeLots}:{}),...(options.streaks?{streaks:options.streaks}:{}),
    ...(options.rivalPlayerIds?{rivalPlayerIds:options.rivalPlayerIds}:{}),
  };
}
