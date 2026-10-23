import { clamp } from "../dmath.ts";
import type { CombatActor, CombatContext, CombatPlayer, CombatState } from "./types.ts";

/** Agent-lane sight range: fog shrinks the authored 30 m range; blindness removes it. */
export function sightRange(state:Readonly<CombatState>,ctx:CombatContext,observer:CombatActor,target?:CombatPlayer):number {
  const effect=state.targets[observer.id];
  if (effect && (effect.phase!=="active" || effect.blindUntil>state.tick)) return 0;
  const fog=(ctx.wave??2)>=3 && Number.isFinite(ctx.fog)?clamp(ctx.fog!,0,1):0;
  const marine=fog>.4 && target?.perks?.includes("marine") ? .5:1;
  return 30*(1-.6*fog)*marine;
}
