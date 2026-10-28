import { isCivilianTraffic } from "../civilian-traffic.ts";
import { AGENT_SPEC, ROBOTAXI_BODY, agentsOf, type AgentState } from "../agents.ts";
import { agentActorId } from "../identity.ts";
import { playerPose, ridesByAgent } from "../ride.ts";
import type { SimState } from "../contract.ts";
import { groundHeight, nearbyBuildings, type World } from "../world.ts";
import { dcos, dsin } from "../dmath.ts";
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
  for(const field of METADATA_FIELDS)if(source[field]!==undefined)metadata[field]=source[field];
  return metadata as CombatActorMetadata;
}

type Building = ReturnType<typeof nearbyBuildings>[number];
const wallOf = new WeakMap<Building, Wall>();
/** A building's wall box. Buildings are static world data, so each is measured once; callers get a copy. */
function buildingWall(building: Building): Wall {
  let wall = wallOf.get(building);
  if (!wall) {
    wall = {id:building.id,minX:Math.min(...building.footprint.map(p=>p[0])),maxX:Math.max(...building.footprint.map(p=>p[0])),minY:building.underY??building.baseY,maxY:building.topY,minZ:Math.min(...building.footprint.map(p=>p[1])),maxZ:Math.max(...building.footprint.map(p=>p[1])),footprint:building.footprint};
    wallOf.set(building, wall);
  }
  return {...wall};
}

/** Ordinary cars are opaque physical bodies, without robot damage/firmware semantics. */
function civilianWall(agent: Readonly<AgentState>): Wall {
  const fx=dsin(agent.heading),fz=-dcos(agent.heading),rx=-fz,rz=fx;
  const hl=agent.halfLength??ROBOTAXI_BODY.halfLength,hw=agent.halfWidth??ROBOTAXI_BODY.halfWidth;
  const footprint=([[-1,-1],[-1,1],[1,1],[1,-1]] as const).map(([along,side])=>[agent.x+fx*hl*along+rx*hw*side,agent.z+fz*hl*along+rz*hw*side] as const);
  const rise=Math.abs(dsin(agent.pitch))*hl;
  return {id:`civilian:${agent.id}`,minX:Math.min(...footprint.map(p=>p[0])),maxX:Math.max(...footprint.map(p=>p[0])),
    minY:agent.y-rise,maxY:agent.y+(agent.height??ROBOTAXI_BODY.height)+rise,minZ:Math.min(...footprint.map(p=>p[1])),maxZ:Math.max(...footprint.map(p=>p[1])),footprint};
}

/**
 * Compatibility bridge for the current wave-1 actors. This does not register a system
 * or invent bad firmware. The actor lane supplies classifications and the core lane
 * calls the reducer after movement. Missing protection metadata always fails closed.
 */
export function contextFromState(world:World,state:Readonly<SimState>,options:CombatAdapterOptions={}):CombatContext {
  const players:CombatPlayer[]=sortedIds(state.players).map(id=> {
    const owner=state.players[id]!;
    const body=playerPose(owner);
    return {tankTier:0,flowTier:0,scannerTier:1,...options.loadouts?.[id],id,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:body.speed,mount:owner.mode==="foot"?"foot":"vehicle"};
  });
  // design.md: a robotaxi with a rider aboard never seizes; it pulls over and the rider steps out.
  const ridden=ridesByAgent(state);
  const actors:CombatActor[]=agentsOf(state).filter(agent=>!isCivilianTraffic(agent)).map(agent=> {
    const id=agentActorId(agent.id), spec=AGENT_SPEC[agent.kind], person=agent.kind==="person";
    // The defaults, then the actor lane's metadata (its defined descriptive fields), then the body.
    const actor:Record<string,unknown>={kind:person?"person":"robot",firmware:person?"none":"good",model:agent.kind==="robotaxi"?"robotaxi":agent.kind==="sidewalkBot"?"trundle":"footman",radius:spec.radius,height:agent.kind==="sidewalkBot"?0.7:1.8,protected:person,obeysTraffic:agent.kind==="robotaxi"};
    const source=options.actorMetadata?.[id] as Readonly<Record<string,unknown>>|undefined;
    if(source)for(const field of METADATA_FIELDS){const value=source[field];if(value!==undefined)actor[field]=value;}
    if(agent.kind==="robotaxi"&&ridden.has(agent.id))actor.occupied=true;
    actor.id=id;actor.x=agent.x;actor.y=agent.y;actor.z=agent.z;actor.heading=agent.heading;actor.speed=agent.speed;
    return actor as unknown as CombatActor;
  });
  for (const player of players) {
    const id=`player:${player.id}`;
    actors.push({kind:"player",firmware:"none",robotBody:false,radius:0.35,height:1.8,...actorMetadata(options,id),id,playerId:player.id,x:player.x,y:player.y,z:player.z,heading:player.heading,speed:player.speed});
  }
  actors.push(...(options.extraActors??[]));
  if(state.version>=21)for(let i=actors.length-1;i>=0;i--){
    const actor=actors[i]!,target=state.ext.combat?.targets[actor.id];
    if(actor.kind!=="robot"||actor.protected||!target)continue;
    if(target.phase==="cleared"){actors.splice(i,1);continue;}
    if(target.phase==="slumping"||target.phase==="heap")actors[i]={...actor,height:actor.height*Math.max(.3,Math.min(1,target.heightScale))};
  }
  const walls:Wall[]=[...(options.walls??[]),...agentsOf(state).filter(isCivilianTraffic).map(civilianWall)];
  const seen=new Set(walls.map(wall=>wall.id));
  for (const player of players) for (const building of nearbyBuildings(world,player.x,player.z,40)) {
    if (seen.has(building.id)) continue;
    seen.add(building.id);
    walls.push(buildingWall(building));
  }
  return {simVersion:state.version,wave:options.wave??2,actors,players,walls,refills:options.refills??[],groundHeight:(x,z)=>groundHeight(world,x,z),
    ...(options.attacks?{attacks:options.attacks}:{}),...(options.conversionCap!==undefined?{conversionCap:options.conversionCap}:{}),
    ...(options.fog!==undefined?{fog:options.fog}:{}),...(options.fogAt?{fogAt:options.fogAt}:{}),...(options.rain!==undefined?{rain:options.rain}:{}),...(options.night!==undefined?{night:options.night}:{}),
    ...(options.mode?{mode:options.mode}:{}),...(options.safeLots?{safeLots:options.safeLots}:{}),...(options.streaks?{streaks:options.streaks}:{}),
    ...(options.rivalPlayerIds?{rivalPlayerIds:options.rivalPlayerIds}:{}),
    ...(options.worldAgiSequence!==undefined?{worldAgiSequence:options.worldAgiSequence}:{}),
    ...(options.devicePlacementAllowed?{devicePlacementAllowed:options.devicePlacementAllowed}:{}),
    ...(options.aimPlacement?{aimPlacement:options.aimPlacement}:{}),...(options.deviceEffectAllowed?{deviceEffectAllowed:options.deviceEffectAllowed}:{}),
  };
}
