// The horn end to end below the browser: H in the stepped frame startles a nearby person in
// the sim, the audio hook reports the blast (so it sounds), and the drawn person turns to look
// at the player while the sim's own heading is untouched.
import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { allocateActorIds } from "../../../src/sim/identity.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { renderWithRuntimeActors } from "../../../src/render/runtime-actors.ts";
import { HORN_HEARD_M, hornBlasts, hornGain } from "../../../src/audio/horn.ts";

const world = buildWorld([]);
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };

function setup(personX: number) {
  const initial = createInitialState(world, 3, ["p"], { x: 0, z: 0, heading: 0 });
  const reserved = allocateActorIds(initial, ["walker"]);
  const spawn: RuntimeSpawn = { id: "walker", numericId: reserved.ids.walker!, model: "person", firmware: "none",
    x: personX, y: 0, z: 0, heading: Math.PI / 2, radius: .3, height: 1.7 };
  const systems = [createAgentsSystem(() => ({ spawns: [spawn], services: false }))];
  let state = reserved.state;
  for (let i = 0; i < 3; i++) state = step(world, state, { p: idle }, [], systems);
  return { state, systems };
}

describe("horn", () => {
  it("startles a person within earshot, sounds, and turns the drawn person toward the car", () => {
    const { state: before, systems } = setup(12);
    expect(agentsRuntimeOf(before)!.actors.walker!.reaction.mode).toBe("idle");
    const frame = { p: { ...idle, actions: Action.horn } };
    const after = step(world, before, frame, [], systems);
    const walker = agentsRuntimeOf(after)!.actors.walker!;
    expect(walker.reaction.mode).toBe("startle");
    expect(walker.reaction.source).toMatchObject({ id: "p" });

    const blasts = hornBlasts(frame, after);
    expect(blasts).toEqual([{ playerId: "p", x: after.players.p!.car.x, z: after.players.p!.car.z, inVehicle: true }]);
    expect(hornGain(blasts[0]!, { x: 0, z: 0 })).toBeGreaterThan(0.9);

    const drawn = renderWithRuntimeActors(after, Object.values(agentsRuntimeOf(after)!.actors)).ext.agents!.list
      .find(body => body.id === walker.legacyId || body.id === walker.numericId)!;
    // The player is due west of the person: compass bearing 270 degrees.
    expect(drawn.heading).toBeCloseTo(-Math.PI / 2, 1);
    expect(walker.heading).not.toBeCloseTo(-Math.PI / 2, 1);
  });

  it("is not heard beyond 40 m, and no input means no blast", () => {
    const { state: before, systems } = setup(45);
    const frame = { p: { ...idle, actions: Action.horn } };
    const after = step(world, before, frame, [], systems);
    expect(agentsRuntimeOf(after)!.actors.walker!.reaction.mode).toBe("idle");
    expect(hornBlasts({ p: idle }, after)).toEqual([]);
    expect(hornGain({ playerId: "p", x: HORN_HEARD_M, z: 0, inVehicle: true }, { x: 0, z: 0 })).toBe(0);
  });
});
