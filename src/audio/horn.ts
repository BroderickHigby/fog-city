// The horn: which players honked this tick, read from the same input frame the sim stepped
// with (keyboard H, pad L3 and the touch button all set Action.horn). The audio director plays
// each blast (src/audio/index.ts playHorn: the synthesized horn sample through the effects bus). People and robots react inside the sim (src/sim/agents/reactions.ts, robot
// hearing in src/sim/robots/brain.ts); this file only makes it audible. Read-only: playing
// or failing to play never changes the sim.

import { Action, type InputFrame, type SimState } from "../sim/contract.ts";

export interface HornBlast {
  playerId: string;
  x: number;
  z: number;
  /** A car horn from the driver's seat; on foot a smaller pocket air horn. */
  inVehicle: boolean;
}

/** design.md: the horn is heard within 40 m; the player hears it a little further. */
export const HORN_HEARD_M = 60;

/** Every player whose stepped input this tick carried the horn, in player-id order. */
export function hornBlasts(frame: InputFrame, state: Readonly<SimState>): HornBlast[] {
  const out: HornBlast[] = [];
  for (const id of Object.keys(frame).sort()) {
    const input = frame[id];
    const player = state.players[id];
    if (!input || !player || (input.actions & Action.horn) === 0) continue;
    const foot = player.mode === "foot" && player.foot !== null;
    const body = foot ? player.foot! : player.car;
    out.push({ playerId: id, x: body.x, z: body.z, inVehicle: !foot });
  }
  return out;
}

/** 1 at the listener, fading linearly to 0 at HORN_HEARD_M. */
export function hornGain(blast: HornBlast, listener: { x: number; z: number }): number {
  const d = Math.hypot(blast.x - listener.x, blast.z - listener.z);
  return d >= HORN_HEARD_M ? 0 : 1 - d / HORN_HEARD_M;
}
