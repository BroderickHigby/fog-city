import { DT, type SimState, type SimInput, type CarState } from "./contract.ts";
import { AGENT_SPEC, type AgentState } from "./agents.ts";
import { carBox, makeCar, stepCar } from "./car.ts";
import { boxBlocked, boxCrossedWall, type Box, type Circle } from "./collide.ts";
import { boxDistance } from "./dodge.ts";
import { dcos, dsin, wrapAngle, clamp } from "./dmath.ts";
import { circleBlocked, segmentBlocked, surfaceHeight, type World } from "./world.ts";

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
}
export type ObservedBody = Pick<AgentMotionProposal, "id" | "x" | "y" | "z" | "heading" | "speed">;

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
    if(a.kind==="robotaxi")boxes.push({x:a.x,z:a.z,heading:a.heading,hl:a.halfLength??2.2,hw:a.halfWidth??.95});
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
  const list = ext.list.filter(a => !retired.has(a.runtimeId ?? `agent:${a.id}`));
  const seen = new Set<number>();
  const names = new Set<string>();
  for (const motion of [...motions].sort((a,b) => a.numericId-b.numericId)) {
    valid(motion);
    if (seen.has(motion.numericId) || names.has(motion.id)) throw new Error("Duplicate physical actor ID");
    seen.add(motion.numericId); names.add(motion.id);
    const conflictingBody = list.find(a => a.runtimeId === motion.id && a.id !== motion.numericId);
    if (conflictingBody) throw new Error("Physical actor identity changed");
    const index = list.findIndex(a => a.id === motion.numericId);
    if (index >= 0) {
      const body = list[index]!;
      if ((body.kind === "robotaxi") !== (motion.kind === "vehicle")) throw new Error("Physical actor body kind changed");
      if (body.runtimeId !== undefined ? body.runtimeId !== motion.id : motion.legacyId !== body.id || motion.id !== `agent:${body.id}`) throw new Error("Physical actor identity changed");
      list[index] = { ...body, runtimeId:motion.id, runtimeLegacy:body.runtimeLegacy ?? motion.legacyId !== null,
        radius:motion.radius,height:motion.height,
        ...(motion.halfLength!==undefined?{halfLength:motion.halfLength}:{}),...(motion.halfWidth!==undefined?{halfWidth:motion.halfWidth}:{}),
        ...(motion.protected!==undefined?{protected:motion.protected}:{}),...(motion.child!==undefined?{child:motion.child}:{}),
        ...(motion.mobilityAid!==undefined?{mobilityAid:motion.mobilityAid}:{}),...(motion.posture!==undefined?{posture:motion.posture}:{}) };
      continue;
    }
    if (motion.kind === "flying") continue;
    if (motion.legacyId !== null) throw new Error("Controlled legacy actor is missing");
    if (occupied(world,{...state,ext:{...state.ext,agents:{...ext,list}}},motion,motion.sourceX,motion.sourceY,motion.sourceZ,motion.heading)) throw new Error("Actor spawn is blocked or overlaps a vehicle/body");
    list.push({ id: motion.numericId, runtimeId: motion.id, runtimeLegacy:false, kind: motion.kind === "vehicle" ? "robotaxi" : motion.bodyKind === "robot" ? "errandRobot" : "person",
      x: motion.sourceX, y: motion.sourceY, z: motion.sourceZ, heading: motion.heading, speed: 0, radius: motion.radius, height: motion.height,
      protected:motion.bodyKind === "animal" || motion.protected === true || motion.bodyKind === undefined,
      child:motion.child??false,mobilityAid:motion.mobilityAid??false,posture:motion.posture??"standing",
      ...(motion.halfLength ? {halfLength:motion.halfLength}:{}), ...(motion.halfWidth ? {halfWidth:motion.halfWidth}:{}),
      pitch:0,vmax:0,edge:"",dir:1,lane:0,s:0,next:"",ndir:1,nlane:0,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go",rng:motion.numericId,dodge:null });
  }
  list.sort((a,b) => a.id-b.id);
  return { ...state, ext: { ...state.ext, agents: { nextId: Math.max(ext.nextId, ...list.map(a => a.id + 1)), list } } };
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
  for(let i=0;i<vehicles.length;i++)for(let j=i+1;j<vehicles.length;j++){
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
  const effective=motions.map(motion=>{
    if(motion.kind!=="vehicle"||!motion.controls)return motion;
    const body=state.ext.agents!.list.find(a=>a.id===motion.numericId);if(!body)return motion;
    const controls=motion.controls;
    const finite=(value:number,min:number,max:number)=>Number.isFinite(value)?clamp(value,min,max):0;
    const input={throttle:finite(controls.throttle,-1,1),steer:finite(controls.steer,-1,1),brake:finite(controls.brake,0,1),actions:0};
    const previous=body.vehicle??makeCar(body.x,body.z,body.heading,body.y);
    const car=stepCar(world,{...previous,x:body.x,y:body.y,z:body.z,heading:body.heading,speed:body.speed},input);
    physicalCars.set(body.id,car);
    const dx=car.x-body.x,dz=car.z-body.z;
    return {...motion,x:car.x,y:car.y,z:car.z,heading:car.heading,speed:Math.sqrt(dx*dx+dz*dz)/DT};
  });
  const byId = new Map(effective.filter(m => m.kind !== "flying").map(m => [m.numericId,m]));
  const vehicleConflicts=conflictingVehicleIntents(state.ext.agents.list,byId);
  const list = state.ext.agents.list.map(body => {
    const motion = byId.get(body.id);
    if (!motion || body.dodge) return body;
    const dx = motion.x-body.x,dz = motion.z-body.z,length = Math.sqrt(dx*dx+dz*dz);
    const allowed = Math.min(length, Math.abs(motion.speed)*DT + 1e-6);
    const x = body.x + (length>0?dx/length*allowed:0), z = body.z + (length>0?dz/length*allowed:0);
    let blocked = vehicleConflicts.has(body.id) || motion.kind!=="vehicle" && (circleBlocked(world,x,z,motion.radius) || segmentBlocked(world,body.x,body.z,x,z));
    if (motion.kind === "walker") for (const id of Object.keys(state.players).sort()) {
      const box=carBox(state.players[id]!.car),fx=dsin(box.heading),fz=-dcos(box.heading);
      const before=boxDistance(body.x,body.z,box.x,box.z,fx,fz,box.hl,box.hw),after=boxDistance(x,z,box.x,box.z,fx,fz,box.hl,box.hw);
      if (after<motion.radius+.1 && after<before) blocked=true;
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
    return { ...body, x:blocked?body.x:x,z:blocked?body.z:z,y:blocked?body.y:y,heading,
      speed:blocked?0:car?car.speed:allowed/DT,
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
