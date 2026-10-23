import { Action, type SimInput, type SimState } from "../contract.ts";
import { clamp, dcos, dsin } from "../dmath.ts";
import { seedRng } from "../rng.ts";
import { stepAttacks } from "./attacks.ts";
import { applyWaterHit, stepSupport, tickEffects } from "./effects.ts";
import { advanceProjectile } from "./physics.ts";
import { waterShot } from "./weapons.ts";
import { capacity, emit, initialPlayer, initialTarget, MAX_PROJECTILES, newlyPressed, protectedActor, safeAngle, sortedActors, sortedPlayers, targetOf } from "./shared.ts";
import type { CombatActor, CombatContext, CombatInputs, CombatPlayer, CombatState, PlayerCombat, Projectile, TargetCombat } from "./types.ts";

export const COMBAT_EXT_KEY = "combat";
export const COMBAT_LIMITS = { actors: 4096, players: 64, projectiles: MAX_PROJECTILES, particleTicks: 240 } as const;

function validateContext(ctx: CombatContext): void {
  if ((ctx.attacks?.length ?? 0) > 4096) throw new Error("Combat attack request budget exceeded");
  if (ctx.players.length > COMBAT_LIMITS.players || ctx.actors.length > COMBAT_LIMITS.actors) throw new Error("Combat context exceeds actor budget");
  for (const records of [ctx.players, ctx.actors]) {
    const ids = new Set<string>();
    for (const item of records) {
      if (!item.id || item.id.length > 128 || Object.hasOwn(Object.prototype,item.id) || item.id === "prototype" || ids.has(item.id)) throw new Error("Combat context requires unique stable IDs");
      ids.add(item.id);
      if (![item.x,item.y,item.z,item.heading,item.speed].every(Number.isFinite)) throw new Error("Combat poses must be finite");
    }
  }
  for (const actor of ctx.actors) {
    if (!Number.isFinite(actor.radius) || actor.radius <= 0 || !Number.isFinite(actor.height) || actor.height <= 0) throw new Error("Combat actor dimensions must be positive");
  }
  for (const player of ctx.players) {
    if (![0,1,2].includes(player.tankTier) || ![0,1].includes(player.flowTier) || ![1,2,3,4].includes(player.scannerTier)) throw new Error("Unknown combat upgrade tier");
  }
}

export function createCombatState(seed: number, ctx: CombatContext, tick = 0): CombatState {
  validateContext(ctx);
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Combat tick must be a nonnegative integer");
  const players: Record<string,PlayerCombat> = {};
  const targets: Record<string,TargetCombat> = {};
  for (const player of sortedPlayers(ctx)) { players[player.id] = initialPlayer(player); targets[player.id] = initialTarget(); }
  for (const actor of sortedActors(ctx)) targets[actor.id] = initialTarget();
  return { version:1,tick,rng:seedRng(seed),nextId:1,players,targets,projectiles:[],gadgets:[],attacks:[],attackSequence:{},events:[],pauseUntil:0 };
}

function cloneState(prev: CombatState, ctx: CombatContext): CombatState {
  const players: Record<string,PlayerCombat> = {};
  const targets: Record<string,TargetCombat> = {};
  const actorIds=new Set(ctx.actors.map(actor=>actor.id));
  for (const player of sortedPlayers(ctx)) {
    const old = prev.players[player.id] ?? initialPlayer(player);
    const target=prev.targets[player.id]??initialTarget();
    targets[player.id]={...target,wetHits:[...target.wetHits]};
    players[player.id] = { ...old,streakSequence:{...old.streakSequence},held:[...old.held],marks:old.marks.filter(mark=>actorIds.has(mark.targetId)).slice(0,COMBAT_LIMITS.actors).map(mark=>({...mark})),scan:old.scan ? {...old.scan}:null };
  }
  for (const actor of sortedActors(ctx)) {
    const old = prev.targets[actor.id] ?? initialTarget();
    targets[actor.id] = {...old,wetHits:[...old.wetHits]};
  }
  return {
    ...prev,tick:prev.tick+1,rng:[...prev.rng],players,targets,
    projectiles:prev.projectiles.map(p=>({...p})),gadgets:prev.gadgets.map(g=>({...g})),
    attacks:prev.attacks.map(a=>({...a})),attackSequence:{...prev.attackSequence},events:[],
  };
}

function aim(player: CombatPlayer, yaw: number|undefined, pitch: number|undefined): { yaw: number; pitch: number } {
  return { yaw:safeAngle(yaw,player.heading), pitch:clamp(Number.isFinite(pitch)?pitch!:0.2,-1.2,1.2) };
}

function spawn(state: CombatState, player: CombatPlayer, kind: Projectile["kind"], yaw: number, pitch: number, speed: number, range: number, volume: number, rustRate: number, verticalSpeed?: number): void {
  const cp=dcos(pitch), fx=dsin(yaw), fz=-dcos(yaw);
  const own=state.players[player.id]!;
  const inheritedSpeed=kind==="cone" && player.mount!=="foot" ? player.speed : 0;
  const vx=fx*speed*cp+dsin(player.heading)*inheritedSpeed;
  const vz=fz*speed*cp-dcos(player.heading)*inheritedSpeed;
  // Cone range describes the throw relative to its moving carrier. Preserve its
  // flight-time budget after adding the carrier's world-space velocity.
  const worldRange=inheritedSpeed!==0 ? range*Math.sqrt(vx*vx+vz*vz)/speed : range;
  state.projectiles.push({
    id:state.nextId++,kind,ownerId:player.id,x:player.x,y:player.y+1.2,z:player.z,
    vx,vy:verticalSpeed ?? dsin(pitch)*speed,vz,
    distance:0,range:worldRange,bornTick:state.tick,volume,salt:own.salt,
    vehicle:player.mount!=="foot",rustRate,
  });
}

/** Firing positions and upgrades are selected by the wave-gated weapon rules. */
function fireWeapons(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  for (const player of sortedPlayers(ctx)) {
    const input=inputs[player.id]??{}, own=state.players[player.id]!;
    const direction=aim(player,input.aimYaw,input.aimPitch);
    const shot=waterShot(state,player,input,ctx);
    if (shot && state.projectiles.length<MAX_PROJECTILES) {
      own[shot.supply]=Math.max(0,own[shot.supply]-shot.volume);
      own.nextWaterTick=state.tick+shot.rateTicks;
      state.projectiles.push({id:state.nextId++,kind:"water",ownerId:player.id,x:player.x,y:shot.spawnHeight,z:player.z,
        vx:shot.direction.x*shot.speed,vy:shot.direction.y*shot.speed,vz:shot.direction.z*shot.speed,
        distance:0,range:shot.range,bornTick:state.tick,volume:shot.volume,salt:shot.salt,vehicle:shot.vehicle,rustRate:shot.rustRate});
      emit(state,"weapon.water",player.id,"",shot.volume);
    }
    if (newlyPressed(own,"cone",input.cone===true) && own.cones>0 && state.tick>=own.nextConeTick && state.projectiles.length<MAX_PROJECTILES) {
      own.cones-=1;
      own.nextConeTick=state.tick+30;
      spawn(state,player,"cone",direction.yaw,0,8,8,0,0,3.705);
      emit(state,"weapon.cone",player.id,"",own.cones);
    }
  }
}

function coneHit(state:CombatState,projectile:Projectile,actor:CombatActor):void {
  if (protectedActor(actor) || actor.kind==="person" || actor.kind==="animal" || actor.kind==="player") return;
  const target=targetOf(state,actor.id);
  if (actor.firmware==="bad") {
    target.blindUntil=Math.max(target.blindUntil,state.tick+180);
    emit(state,"robot.blinded",projectile.ownerId,actor.id,180);
  }
  const heading=safeAngle(actor.heading);
  const front=(projectile.x-actor.x)*dsin(heading)-(projectile.z-actor.z)*dcos(heading);
  const onHood=front>0 && projectile.y>=actor.y+actor.height*.35;
  if (actor.model==="robotaxi" && actor.obeysTraffic===true && onHood) {
    target.pullOverTick=state.tick+180;
    target.pullOverSpeed=Math.abs(actor.speed);
    target.stoppedUntil=Math.max(target.stoppedUntil,state.tick+600);
    emit(state,"vehicle.pull-over",projectile.ownerId,actor.id,180);
  }
}

function particles(state:CombatState,ctx:CombatContext):void {
  const alive:Projectile[]=[];
  for (const projectile of state.projectiles.sort((a,b)=>a.id-b.id)) {
    if (!state.players[projectile.ownerId] || state.tick-projectile.bornTick>=COMBAT_LIMITS.particleTicks) continue;
    const moved=advanceProjectile(projectile,ctx);
    if (moved.hit) {
      if (projectile.kind==="water") applyWaterHit(state,moved.hit,projectile);
      if (projectile.kind==="cone") coneHit(state,moved.projectile,moved.hit);
    }
    if (moved.hit || moved.landed || moved.blocked || moved.expired) {
      emit(state,"projectile.ended",projectile.ownerId,moved.hit?.id??"",projectile.id,moved.hit?"actor":moved.blocked?"wall":moved.landed?"ground":"range");
    } else alive.push(moved.projectile);
  }
  state.projectiles=alive;
}

/** Pure reducer. Context is a read-only snapshot; output owns all mutable combat data. */
export function stepCombat(prev: Readonly<CombatState>, ctx: CombatContext, inputs: CombatInputs = {}): CombatState {
  validateContext(ctx);
  if (prev.version!==1 || !Number.isSafeInteger(prev.tick) || prev.tick<0) throw new Error("Unsupported combat state");
  const state=cloneState(prev as CombatState,ctx);
  stepSupport(state,ctx,inputs);
  fireWeapons(state,ctx,inputs);
  particles(state,ctx);
  tickEffects(state,ctx);
  stepAttacks(state,ctx,inputs);
  for (const player of sortedPlayers(ctx)) {
    const input=inputs[player.id]??{}, own=state.players[player.id]!;
    own.water=clamp(own.water,0,capacity(player));
    own.held=["cone","gadget","gear","streak","breakFree","closeAd"].filter(action=> {
      if (action==="gadget") return input.gadget!==undefined;
      if (action==="streak") return input.streak!==undefined;
      return Boolean(input[action as "cone"|"gear"|"breakFree"|"closeAd"]);
    });
  }
  return state;
}

export function combatOf(state: Readonly<SimState>): CombatState | undefined {
  return state.ext[COMBAT_EXT_KEY] as CombatState|undefined;
}

/** Core-lane integration point: call after movement, with current actors and recorded inputs. */
export function stepCombatSystem(previous: Readonly<SimState>, next: SimState, ctx: CombatContext, inputs: CombatInputs): SimState {
  const old=combatOf(previous)??createCombatState(previous.seed,ctx,previous.tick);
  if (old.tick!==previous.tick || next.tick!==previous.tick+1) throw new Error("Combat and simulation ticks must stay synchronized");
  return {...next,ext:{...next.ext,[COMBAT_EXT_KEY]:stepCombat(old,ctx,inputs)}};
}

/** Existing wave-1 bits only; new actions stay explicit until the core interface lands. */
export function combatInput(input: Readonly<SimInput>): CombatInputs[string] {
  return {fire:(input.actions&Action.fire)!==0,scan:(input.actions&Action.scan)!==0};
}

/** Null means unrestricted acceleration. Agent lane applies a non-null cap before movement; this function does not mutate its body. */
export function movementLimit(state:Readonly<CombatState>,actor:Pick<CombatActor,"id"|"playerId">):{maxSpeed:number|null;scale:number;blind:boolean;canAttack:boolean} {
  const target=state.targets[actor.id];
  const canonical=actor.playerId?state.targets[actor.playerId]:undefined;
  if (!target && !canonical) return {maxSpeed:null,scale:1,blind:false,canAttack:true};
  const constraints=[target,canonical].filter((item):item is TargetCombat=>item!==undefined);
  let maxSpeed:number|null=null;
  for (const target of constraints) if (target.pullOverTick>0) {
    const cap=target.pullOverSpeed*clamp((target.pullOverTick-state.tick)/180,0,1);
    maxSpeed=maxSpeed===null?cap:Math.min(maxSpeed,cap);
  }
  const decelerating=(target:TargetCombat)=>target.phase==="disabled" && target.pullOverTick>state.tick;
  const immobilized=constraints.some(target=>target.phase!=="active" && !decelerating(target) || target.stoppedUntil>state.tick && target.pullOverTick===0);
  return {maxSpeed:immobilized?0:maxSpeed,scale:immobilized?0:Math.min(...constraints.map(target=>decelerating(target)?1:target.slowUntil>state.tick?Math.min(.5,target.movementScale):target.movementScale)),blind:constraints.some(target=>target.blindUntil>state.tick),canAttack:constraints.every(target=>target.phase==="active" && target.blindUntil<=state.tick && target.stoppedUntil<=state.tick && target.distractedUntil<=state.tick)};
}
