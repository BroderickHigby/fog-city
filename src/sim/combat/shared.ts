import type { CombatActor, CombatContext, CombatEvent, CombatPlayer, CombatState, PlayerCombat, TargetCombat, Vec3 } from "./types.ts";

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const MAX_PROJECTILES = 1024;
export const MAX_GADGETS = 128;
export const FIDELITY_RADIUS = 350;
export function distance2(a: Pick<Vec3, "x" | "z">, b: Pick<Vec3, "x" | "z">): number { const dx=a.x-b.x, dz=a.z-b.z; return dx*dx+dz*dz; }
export function protectedActor(a: CombatActor): boolean {
  return a.protected === true || a.kind === "animal" || a.kind === "person" && (a.child === true || a.mobilityAid === true || a.posture === "seated" || a.posture === "lying") || a.kind === "player" && a.robotBody !== true;
}
export function robotActor(a: CombatActor): boolean { return a.kind === "robot" || a.kind === "player" && a.robotBody === true; }
export function capacity(p: CombatPlayer): number { return Math.max(1, 8 + p.tankTier * 4 - (p.perks?.includes("lean") ? 2 : 0)); }
export function initialPlayer(p: CombatPlayer): PlayerCombat {
  return { water:capacity(p),salt:false,reserve:p.trunk?20:0,cones:3,balloons:2,nextWaterTick:0,nextConeTick:0,nextFlowerTick:0,nextGadgetTick:0,nextGearTick:0,gearUntil:0,gear:"none",refillId:"",refillTicks:0,scanId:"",scanTicks:0,nextScanTick:0,scan:null,previousMount:p.mount,held:[],boost:"none",boostUntil:0,lastParrotsTick:-3600,streakSequence:{},marks:[] };
}
export function initialTarget(): TargetCombat {
  return { rust:0,phase:"active",phaseTick:0,lastWaterTick:-1000,heightScale:1,puddle:false,repair:false,penalized:false,wetHits:[],wetUntil:0,blindUntil:0,waryUntil:0,alerted:false,pullOverTick:0,pullOverSpeed:0,stoppedUntil:0,flowersUntil:0,slowUntil:0,distractedUntil:0,sourceId:"",movementScale:1,windupScale:1 };
}
export function targetOf(state: CombatState, id:string): TargetCombat { return state.targets[id] ?? (state.targets[id] = initialTarget()); }
export function emit(state:CombatState, kind:string, sourceId="", targetId="", amount=0, detail=""):CombatEvent {
  const event={id:state.nextId++,tick:state.tick,kind,sourceId,targetId,amount,detail}; state.events.push(event); return event;
}
export function actorById(ctx:CombatContext,id:string):CombatActor|undefined { return ctx.actors.find(a=>a.id===id); }
export function playerById(ctx:CombatContext,id:string):CombatPlayer|undefined { return ctx.players.find(p=>p.id===id); }
export function sortedActors(ctx:CombatContext):CombatActor[] { return [...ctx.actors].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0); }
export function sortedPlayers(ctx:CombatContext):CombatPlayer[] { return [...ctx.players].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0); }
export function newlyPressed(p:PlayerCombat, action:string, pressed:boolean):boolean { return pressed && !p.held.includes(action); }
/** Bound arbitrary finite input angles before deterministic polynomial trig. */
export function safeAngle(value:number|undefined,fallback=0):number {
  return (Number.isFinite(value)?value!:fallback) % 6.283185307179586;
}
