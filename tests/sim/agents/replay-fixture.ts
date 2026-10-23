import { createRobotBrain, stepRobotBrain } from "../../../src/sim/robots/brain.ts";
import { buildSidewalkGraph, shortestSidewalkRoute } from "../../../src/sim/agents/navigation.ts";
import { planFidelity } from "../../../src/sim/agents/fidelity.ts";
import { IDLE_REACTION, reactToPerception } from "../../../src/sim/agents/reactions.ts";
import { dsin } from "../../../src/sim/dmath.ts";
import { hashState } from "../../../src/sim/serialize.ts";

/** Identical fixture imported by Node and an actual browser, without a renderer or test runner. */
export function replayPolicyTrace(): string[] {
  const graph = buildSidewalkGraph({
    nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 100, z: 0 }],
    edges: [{ id: "ab", a: "a", b: "b", points: [[0, 0], [100, 0]], kind: "sidewalk", bidirectional: true }],
  });
  const route = shortestSidewalkRoute(graph, "a", "b");
  let brain = createRobotBrain({ id: 17 });
  let reaction = IDLE_REACTION;
  const trace: string[] = [];
  for (let tick = 0; tick < 1800; tick++) {
    const result = stepRobotBrain(brain, {
      tick,
      self: { x: 0, z: 0, heading: 0, rust: tick >= 1200 ? 0.65 : 0, fogDensity: tick >= 900 ? 0.8 : 0, shoved: false },
      observations: {
        sight: [{ kind: "robot", id: 23, alignment: "good", operational: true, x: 0, z: -2, lineOfSight: tick < 700 }],
        sounds: tick % 240 === 0 ? [{ kind: "horn", playerId: "p1", x: dsin(tick / 30) * 10, z: -8 }] : [],
        broadcasts: [], scans: [], watches: [],
      },
      conversion: { withinFidelity: tick < 1500, protectedArea: false, baseBadCount: 2, badCount: 2 },
    });
    brain = result.state;
    const reacted = reactToPerception({
      actor: { id: "pigeon:1", kind: "pigeon", x: 3, z: 0, wet: false }, state: reaction,
      stimuli: tick % 120 === 0 ? [{ sourceId: "p1", kind: "horn", x: 0, z: 0, seen: false, heard: true }] : [],
      tick, dodgeOverrideActive: tick % 300 < 20,
    });
    reaction = reacted.state;
    const fidelity = planFidelity({ id: "ambient:1", x: tick / 4, z: 0, significant: tick > 600 }, [{ id: "p1", x: 0, z: 0 }], tick);
    if (tick % 60 === 59) trace.push(hashState({ brain, intent: result.intent, reaction: reacted, fidelity, route }));
  }
  return trace;
}
