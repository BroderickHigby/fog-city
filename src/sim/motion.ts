import { DT, type SimState, type SimInput, type CarState } from "./contract.ts";
import { agentActorId } from "./identity.ts";
import { AGENT_SPEC, ROBOTAXI_BODY, type AgentState } from "./agents.ts";
import { CAR, carBox, makeCar, stepCar } from "./car.ts";
import { boxBlocked, boxCrossedWall, type Box, type Circle } from "./collide.ts";
import { boxDistance } from "./dodge.ts";
import { dcos, dsin, wrapAngle, clamp } from "./dmath.ts";
import { circleBlocked, segmentBlocked, surfaceHeight, type World } from "./world.ts";
import { movementLimit } from "./combat/system.ts";

export interface AgentMotionProposal {
  id: string;
  numericId: number;
  legacyId: number | null;
  kind: "walker" | "vehicle" | "flying";
  controls?: Readonly<SimInput>;
  bodyKind?: "robot" | "person" | "animal";
  protected?: boolean;
  child?: boolean;
  mobilityAid?: boolean;
  posture?: "standing" | "seated" | "lying";
  x: number; y: number; z: number; heading: number; speed: number;
  radius: number; height: number;
  halfLength?: number; halfWidth?: number;
  sourceX: number; sourceY: number; sourceZ: number;
  /** v14: the proposal covers this many ticks of travel (a distant walker planning at a lower rate); speed is per stride. */
  strideTicks?: number;
}
export type ObservedBody = Pick<AgentMotionProposal, "id" | "x" | "y" | "z" | "heading" | "speed">;

/** Runtime bodies and their legacy adapter alias must obey the same combat effects. */
function combatRestriction(state: Readonly<SimState>, motion: AgentMotionProposal): { cap: number; scale: number } {
  const combat = state.ext.combat;
  if (!combat) return { cap: Infinity, scale: 1 };
  const own = movementLimit(combat, { id: motion.id });
  const alias = motion.id === agentActorId(motion.numericId) ? own : movementLimit(combat, { id: agentActorId(motion.numericId) });
  return { cap: Math.min(own.maxSpeed ?? Infinity, alias.maxSpeed ?? Infinity), scale: Math.min(own.scale, alias.scale) };
}

function boxesTouch(a:Box,b:Box):boolean {
  const afx=dsin(a.heading),afz=-dcos(a.heading),bfx=dsin(b.heading),bfz=-dcos(b.heading);
  for(const [x,z] of [[afx,afz],[-afz,afx],[bfx,bfz],[-bfz,bfx]]) {
    const ar=a.hl*Math.abs(afx*x!+afz*z!)+a.hw*Math.abs(-afz*x!+afx*z!);
    const br=b.hl*Math.abs(bfx*x!+bfz*z!)+b.hw*Math.abs(-bfz*x!+bfx*z!);
    if(Math.abs((a.x-b.x)*x!+(a.z-b.z)*z!)>=ar+br)return false;
  }
  return true;
}
function obstacles(state:Readonly<SimState>,ignore:number):{circles:Circle[];boxes:Box[]} {
  const circles:Circle[]=[],boxes:Box[]=[];
  for(const id of Object.keys(state.players).sort()) {
    const p=state.players[id]!; boxes.push(carBox(p.car));
    if(p.mode==="foot"&&p.foot)circles.push({x:p.foot.x,z:p.foot.z,r:.35,person:true});
  }
  for(const a of state.ext.agents?.list??[])if(a.id!==ignore) {
    if(a.kind==="robotaxi")boxes.push({x:a.x,z:a.z,heading:a.heading,hl:a.halfLength??ROBOTAXI_BODY.halfLength,hw:a.halfWidth??ROBOTAXI_BODY.halfWidth});
    else circles.push({x:a.x,z:a.z,r:a.radius??AGENT_SPEC[a.kind].radius,person:a.kind==="person"});
  }
  return {circles,boxes};
}
function occupied(world:World,state:Readonly<SimState>,motion:AgentMotionProposal,x:number,y:number,z:number,heading:number):boolean {
  const other=obstacles(state,motion.numericId);
  if(motion.kind==="vehicle") {
    const box={x,z,heading,hl:motion.halfLength??2.2,hw:motion.halfWidth??.95};
    return boxBlocked(world,box,y+.5,other.circles,y+motion.height)||other.boxes.some(b=>boxesTouch(box,b));
  }
  return circleBlocked(world,x,z,motion.radius)||other.circles.some(c=>(x-c.x)*(x-c.x)+(z-c.z)*(z-c.z)<(motion.radius+c.r)*(motion.radius+c.r))
    ||other.boxes.some(b=>boxDistance(x,z,b.x,b.z,dsin(b.heading),-dcos(b.heading),b.hl,b.hw)<motion.radius);
}

function valid(proposal: AgentMotionProposal): void {
  if (!Number.isSafeInteger(proposal.numericId) || proposal.numericId < 1 || !proposal.id || proposal.id.length > 240
    || (proposal.legacyId !== null && proposal.legacyId !== proposal.numericId)
    || !["walker","vehicle","flying"].includes(proposal.kind)
    || [proposal.halfLength,proposal.halfWidth].some(value => value !== undefined && (!Number.isFinite(value) || value < .2 || value > 15))
    || ![proposal.x,proposal.y,proposal.z,proposal.sourceX,proposal.sourceY,proposal.sourceZ,proposal.heading,proposal.speed,proposal.radius,proposal.height].every(Number.isFinite)
    || Math.abs(proposal.speed) > 60 || [proposal.x,proposal.y,proposal.z,proposal.sourceX,proposal.sourceY,proposal.sourceZ].some(value=>Math.abs(value)>1e7)
    || proposal.radius <= 0 || proposal.radius > 10 || proposal.height <= 0 || proposal.height > 20) throw new Error("Invalid agent motion proposal");
}

/** Admit physical actors before obstacle construction; never let ambient scheduling own them. */
export function prepareMotionBodies(world: World, state: SimState, motions: readonly AgentMotionProposal[], retirements: readonly string[] = []): SimState {
  if (!motions.length && !retirements.length) return state;
  const retired = new Set(retirements);
  const ext = state.ext.agents ?? { nextId: 1, list: [] };
  const list = ext.list.filter(a => !retired.has(a.runtimeId ?? agentActorId(a.id)));
  const seen = new Set<number>();
  const names = new Set<string>();
  // Indexes of the bodies present before admission. A body updated below keeps its id and takes
  // the motion's (unique) runtime id, and admitted bodies carry ids and names already in seen
  // and names, so neither lookup can change answer as the loop runs.
  const firstById = new Map<number, number>();
  const byRuntime = new Map<string, number[]>();
  list.forEach((a, i) => {
    if (!firstById.has(a.id)) firstById.set(a.id, i);
    if (a.runtimeId !== undefined) { const at = byRuntime.get(a.runtimeId); if (at) at.push(i); else byRuntime.set(a.runtimeId, [i]); }
  });
  for (const motion of [...motions].sort((a,b) => a.numericId-b.numericId)) {
    valid(motion);
    if (seen.has(motion.numericId) || names.has(motion.id)) throw new Error("Duplicate physical actor ID");
    seen.add(motion.numericId); names.add(motion.id);
    if (byRuntime.get(motion.id)?.some(i => list[i]!.id !== motion.numericId)) throw new Error("Physical actor identity changed");
    const index = firstById.get(motion.numericId) ?? -1;
    if (index >= 0) {
      const body = list[index]!;
      if ((body.kind === "robotaxi") !== (motion.kind === "vehicle")) throw new Error("Physical actor body kind changed");
      if (body.runtimeId !== undefined ? body.runtimeId !== motion.id : motion.legacyId !== body.id || motion.id !== `agent:${body.id}`) throw new Error("Physical actor identity changed");
      const runtimeLegacy = body.runtimeLegacy ?? motion.legacyId !== null;
      // Structural sharing: a body that already carries every field unchanged is kept as is.
      if (body.runtimeId === motion.id && body.runtimeLegacy === runtimeLegacy && body.radius === motion.radius && body.height === motion.height
        && (motion.halfLength === undefined || body.halfLength === motion.halfLength) && (motion.halfWidth === undefined || body.halfWidth === motion.halfWidth)
        && (motion.protected === undefined || body.protected === motion.protected) && (motion.child === undefined || body.child === motion.child)
        && (motion.mobilityAid === undefined || body.mobilityAid === motion.mobilityAid) && (motion.posture === undefined || body.posture === motion.posture)) continue;
      list[index] = { ...body, runtimeId:motion.id, runtimeLegacy,
        radius:motion.radius,height:motion.height,
        ...(motion.halfLength!==undefined?{halfLength:motion.halfLength}:{}),...(motion.halfWidth!==undefined?{halfWidth:motion.halfWidth}:{}),
        ...(motion.protected!==undefined?{protected:motion.protected}:{}),...(motion.child!==undefined?{child:motion.child}:{}),
        ...(motion.mobilityAid!==undefined?{mobilityAid:motion.mobilityAid}:{}),...(motion.posture!==undefined?{posture:motion.posture}:{}) };
      continue;
    }
    if (motion.kind === "flying") continue;
    // Gameplay conditions, not errors: an ambient body that left the population since the
    // proposal was planned, or a spawn point a body or wall now occupies. The proposal is
    // rejected for this tick and nothing is admitted; the owning system still holds the actor
    // without a body (mission staging waits for one) and proposes it again next tick.
    if (motion.legacyId !== null) continue;
    if (occupied(world,{...state,ext:{...state.ext,agents:{...ext,list}}},motion,motion.sourceX,motion.sourceY,motion.sourceZ,motion.heading)) continue;
    list.push({ id: motion.numericId, runtimeId: motion.id, runtimeLegacy:false, kind: motion.kind === "vehicle" ? "robotaxi" : motion.bodyKind === "robot" ? "errandRobot" : "person",
      x: motion.sourceX, y: motion.sourceY, z: motion.sourceZ, heading: motion.heading, speed: 0, radius: motion.radius, height: motion.height,
      protected:motion.bodyKind === "animal" || motion.protected === true || motion.bodyKind === undefined,
      child:motion.child??false,mobilityAid:motion.mobilityAid??false,posture:motion.posture??"standing",
      ...(motion.halfLength ? {halfLength:motion.halfLength}:{}), ...(motion.halfWidth ? {halfWidth:motion.halfWidth}:{}),
      pitch:0,vmax:0,edge:"",dir:1,lane:0,s:0,next:"",ndir:1,nlane:0,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go",rng:motion.numericId,dodge:null });
  }
  list.sort((a,b) => a.id-b.id);
  return { ...state, ext: { ...state.ext, agents: { nextId: list.reduce((m, a) => Math.max(m, a.id + 1), ext.nextId), list } } };
}

function motionPose(body:Readonly<AgentState>,motion:AgentMotionProposal|undefined,t:number):Box {
  const dx=(motion?.x??body.x)-body.x,dz=(motion?.z??body.z)-body.z,length=Math.sqrt(dx*dx+dz*dz);
  const allowed=Math.min(length,Math.abs(motion?.speed??0)*DT+1e-6);
  return {x:body.x+(length>0?dx/length*allowed*t:0),z:body.z+(length>0?dz/length*allowed*t:0),
    heading:body.heading+clamp(wrapAngle((motion?.heading??body.heading)-body.heading),-2*DT,2*DT)*t,
    hl:motion?.halfLength??body.halfLength??2.2,hw:motion?.halfWidth??body.halfWidth??.95};
}
/** Relative sweeps reject both intents if two simultaneous hulls would intersect. */
function conflictingVehicleIntents(bodies:readonly AgentState[],motions:ReadonlyMap<number,AgentMotionProposal>):Set<number> {
  const blocked=new Set<number>(),vehicles=bodies.filter(body=>body.kind==="robotaxi");
  // Only pairs with at least one intent can conflict, and only within reach (at most two bus
  // hulls plus 2 m): visit each such pair once through a coarse grid instead of all pairs.
  const CELL=24,grid=new Map<number,number[]>(),cellOf=(x:number)=>Math.floor(x/CELL);
  let maxHull=0;
  vehicles.forEach((v,i)=>{
    const m=motions.get(v.id);maxHull=Math.max(maxHull,(m?.halfLength??v.halfLength??2.2)+(m?.halfWidth??v.halfWidth??.95));
    const key=(cellOf(v.x)+32768)*65536+cellOf(v.z)+32768,at=grid.get(key);if(at)at.push(i);else grid.set(key,[i]);
  });
  const span=Math.ceil((2*maxHull+2)/CELL);
  const pairs:Array<[number,number]>=[];
  vehicles.forEach((v,i)=>{
    if(!motions.get(v.id))return;
    for(let cx=cellOf(v.x)-span;cx<=cellOf(v.x)+span;cx++)for(let cz=cellOf(v.z)-span;cz<=cellOf(v.z)+span;cz++)
      for(const j of grid.get((cx+32768)*65536+cz+32768)??[])if(j!==i&&(j>i||!motions.get(vehicles[j]!.id)))pairs.push(i<j?[i,j]:[j,i]);
  });
  for(const [i,j] of pairs){
    const a=vehicles[i]!,b=vehicles[j]!,am=motions.get(a.id),bm=motions.get(b.id);
    if(!am&&!bm)continue;
    const reach=(am?.halfLength??a.halfLength??2.2)+(am?.halfWidth??a.halfWidth??.95)+(bm?.halfLength??b.halfLength??2.2)+(bm?.halfWidth??b.halfWidth??.95)+2;
    if(Math.abs(a.x-b.x)>reach||Math.abs(a.z-b.z)>reach)continue;
    const steps=24;
    for(let k=0;k<=steps;k++)if(boxesTouch(motionPose(a,am,k/steps),motionPose(b,bm,k/steps))){
      if(am)blocked.add(a.id);if(bm)blocked.add(b.id);break;
    }
  }
  return blocked;
}

/** Bounded desired steps use world collision; final vehicle clearance runs afterwards. */
export function applyMotionBodies(world: World, state: SimState, motions: readonly AgentMotionProposal[]): SimState {
  if (!motions.length || !state.ext.agents) return state;
  const physicalCars=new Map<number,CarState>();
  const restricted = new Set<number>();
  const effective=motions.map(motion=>{
    const restriction = combatRestriction(state, motion);
    if (Number.isFinite(restriction.cap) || restriction.scale !== 1) restricted.add(motion.numericId);
    const cap = restriction.scale <= 0 ? 0 : restriction.cap;
    if(motion.kind!=="vehicle"||!motion.controls) {
      const speed = Math.min(Math.abs(motion.speed) * restriction.scale, cap);
      return speed === Math.abs(motion.speed) ? motion : { ...motion, speed };
    }
    const body=state.ext.agents!.list.find(a=>a.id===motion.numericId);if(!body)return motion;
    const controls=motion.controls;
    const finite=(value:number,min:number,max:number)=>Number.isFinite(value)?clamp(value,min,max):0;
    const input={throttle:finite(controls.throttle,-1,1)*restriction.scale,steer:finite(controls.steer,-1,1),brake:finite(controls.brake,0,1),actions:0};
    const previous=body.vehicle??makeCar(body.x,body.z,body.heading,body.y);
    const speedCap = restriction.scale < 1 ? Math.min(cap, CAR.maxSpeed * restriction.scale) : cap;
    if (speedCap === 0) {
      physicalCars.set(body.id, { ...previous, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: 0, lateral: 0, yawRate: 0 });
      return { ...motion, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: 0 };
    }
    const startSpeed = clamp(body.speed, -speedCap, speedCap);
    const car=stepCar(world,{...previous,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:startSpeed},input);
    if (Number.isFinite(speedCap)) {
      const dx = car.x - body.x, dz = car.z - body.z, travel = Math.sqrt(dx * dx + dz * dz);
      const ratio = travel > 0 ? Math.min(1, speedCap * DT / travel) : 1;
      car.x = body.x + dx * ratio; car.z = body.z + dz * ratio;
      car.speed = clamp(car.speed, -speedCap, speedCap); car.lateral *= ratio;
    }
    physicalCars.set(body.id,car);
    const dx=car.x-body.x,dz=car.z-body.z;
    return {...motion,x:car.x,y:car.y,z:car.z,heading:car.heading,speed:Math.sqrt(dx*dx+dz*dz)/DT};
  });
  const byId = new Map(effective.filter(m => m.kind !== "flying").map(m => [m.numericId,m]));
  const vehicleConflicts=conflictingVehicleIntents(state.ext.agents.list,byId);
  const vehicleBoxes=[...Object.keys(state.players).sort().map(id=>({box:carBox(state.players[id]!.car),y:state.players[id]!.car.y,height:CAR.bodyHeight})),
    ...state.ext.agents.list.filter(body=>body.kind==="robotaxi").map(body=>({
      box:{x:body.x,z:body.z,heading:body.heading,hl:body.halfLength??ROBOTAXI_BODY.halfLength,hw:body.halfWidth??ROBOTAXI_BODY.halfWidth},
      y:body.y,height:body.height??ROBOTAXI_BODY.height}))];
  // Vehicle boxes by 16 m cell, so each walker tests only the vehicles that can reach it.
  const VEHICLE_CELL = 16;
  const vehicleGrid = new Map<number, number[]>();
  let vehicleReach = 0;
  vehicleBoxes.forEach((vehicle, i) => {
    vehicleReach = Math.max(vehicleReach, vehicle.box.hl + vehicle.box.hw);
    const key = (Math.floor(vehicle.box.x / VEHICLE_CELL) + 32768) * 65536 + Math.floor(vehicle.box.z / VEHICLE_CELL) + 32768;
    const at = vehicleGrid.get(key);
    if (at) at.push(i); else vehicleGrid.set(key, [i]);
  });
  const nearbyVehicles = (x: number, z: number, reach: number, out: number[]): number[] => {
    out.length = 0;
    for (let cx = Math.floor((x - reach) / VEHICLE_CELL); cx <= Math.floor((x + reach) / VEHICLE_CELL); cx++)
      for (let cz = Math.floor((z - reach) / VEHICLE_CELL); cz <= Math.floor((z + reach) / VEHICLE_CELL); cz++) {
        const at = vehicleGrid.get((cx + 32768) * 65536 + cz + 32768);
        if (at) for (const i of at) out.push(i);
      }
    return out;
  };
  const candidates: number[] = [];
  const list = state.ext.agents.list.map(body => {
    const motion = byId.get(body.id);
    if (!motion || body.dodge) return body;
    const dx = motion.x-body.x,dz = motion.z-body.z,length = Math.sqrt(dx*dx+dz*dz);
    const allowed = Math.min(length, Math.abs(motion.speed)*DT + (restricted.has(body.id) ? 0 : 1e-6));
    const x = body.x + (length>0?dx/length*allowed:0), z = body.z + (length>0?dz/length*allowed:0);
    let blocked = vehicleConflicts.has(body.id) || motion.kind!=="vehicle" && (circleBlocked(world,x,z,motion.radius) || segmentBlocked(world,body.x,body.z,x,z));
    if (motion.kind === "walker") for (const index of nearbyVehicles(body.x, body.z, vehicleReach + motion.radius + allowed + .1, candidates)) {
      const vehicle = vehicleBoxes[index]!;
      const box=vehicle.box,reach=box.hl+box.hw+motion.radius+allowed+.1;
      if(Math.abs(body.x-box.x)>reach||Math.abs(body.z-box.z)>reach||body.y>=vehicle.y+vehicle.height+.1||vehicle.y>=body.y+motion.height+.1)continue;
      const fx=dsin(box.heading),fz=-dcos(box.heading),before=boxDistance(body.x,body.z,box.x,box.z,fx,fz,box.hl,box.hw);
      const steps=Math.max(1,Math.ceil(allowed/.05));
      for(let i=1;i<=steps;i++){
        const t=i/steps,after=boxDistance(body.x+(x-body.x)*t,body.z+(z-body.z)*t,box.x,box.z,fx,fz,box.hl,box.hw);
        if(after<motion.radius+.1&&after<before){blocked=true;break;}
      }
    }
    const y=surfaceHeight(world,x,z,body.y);
    if (Math.abs(y-body.y)>Math.max(.4,allowed)) blocked=true;
    const turn=clamp(wrapAngle(motion.heading-body.heading),-2*DT,2*DT);
    if (motion.kind === "vehicle") {
      const steps=Math.max(1,Math.ceil((allowed+Math.abs(turn)*(motion.halfLength??2.2))/.1));
      for(let i=1;i<=steps&&!blocked;i++){
        const t=i/steps,box={x:body.x+(x-body.x)*t,z:body.z+(z-body.z)*t,heading:body.heading+turn*t,hl:motion.halfLength??2.2,hw:motion.halfWidth??.95};
        if(occupied(world,state,motion,box.x,body.y,box.z,box.heading)||boxCrossedWall(world,box,body))blocked=true;
      }
    }
    const car=physicalCars.get(body.id),heading=blocked?body.heading:body.heading+turn;
    // Structural sharing: a body that stays exactly where it was (blocked or standing) is kept.
    if (!car && (blocked ? body.speed === 0 : allowed === 0 && body.speed === 0 && x === body.x && z === body.z && y === body.y && heading === body.heading)) return body;
    return { ...body, x:blocked?body.x:x,z:blocked?body.z:z,y:blocked?body.y:y,heading,
      speed:blocked?0:car?car.speed:allowed/(DT*(motion.strideTicks??1)),
      ...(car?{vehicle:blocked?{...car,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:0,lateral:0,yawRate:0}:{...car,x,z,y,heading}}:{}) };
  });
  return { ...state, ext:{...state.ext,agents:{...state.ext.agents,list}} };
}

export function observedMotionBodies(state: Readonly<SimState>, motions: readonly AgentMotionProposal[]): ObservedBody[] {
  const bodies=new Map((state.ext.agents?.list??[]).map(body=>[body.id,body]));
  return motions.flatMap(motion=>{
    const body=bodies.get(motion.numericId);
    return body?[{id:motion.id,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:body.speed}]:[];
  });
}
