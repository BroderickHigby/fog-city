import type { MatchLoadout } from "../sim/modes/session.ts";
import type { Progression } from "../sim/player/types.ts";

/** Until the equipment screen chooses slots, unlocked order selects the first three unique entries. */
export function loadoutForMatch(profile:Pick<Progression,"nozzle"|"gadget"|"gear"|"perks"|"streaks">):MatchLoadout {
  return {nozzle:profile.nozzle,gadget:profile.gadget,gear:profile.gear,
    perks:[...new Set(profile.perks)].slice(0,3),streaks:[...new Set(profile.streaks)].slice(0,3),cosmetics:[]};
}
