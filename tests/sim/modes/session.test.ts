import { expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { step } from "../../../src/sim/step.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import { createMatchSession, modeSessionOf, settleSession } from "../../../src/sim/modes/session.ts";
import { createModesSystem } from "../../../src/sim/modes/systems.ts";

it("runs an isolated match through the registry and pays exactly once",()=>{
  const loadout={nozzle:"standard",gadget:"speaker",gear:"boots",perks:["quiet"],streaks:["confidence"],cosmetics:["blue"]};
  const world=buildWorld([]);
  const original=canonicalJson(loadout);
  const initial=createMatchSession(world,{id:"match-7",mode:"botSweep",seed:7,players:["a"],relayId:"relay"},{x:0,z:0,heading:0},{a:loadout});
  loadout.perks.push("stealth");
  expect(modeSessionOf(initial)!.loadouts.a!.perks).toEqual(["quiet"]);
  const system=createModesSystem(context=>({positions:{},combatEvents:[{id:1,tick:context.state.tick,kind:"robot.disabled",sourceId:"a",targetId:"relay",amount:1,detail:""}]}));
  const finished=step(world,initial,{},[],[system]);
  const session=modeSessionOf(finished)!;
  expect(session.match.phase).toBe("finished");expect(session.payouts).toHaveLength(1);
  expect(settleSession(session)).toBe(session);
  const following=step(world,finished,{},[],[system]);expect(modeSessionOf(following)!.payouts).toEqual([]);
  expect(modeSessionOf(initial)!.settled).toBe(false);expect(original).toContain("quiet");
});
