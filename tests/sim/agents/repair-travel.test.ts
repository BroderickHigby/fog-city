import { describe, expect, it } from "vitest";
import type { CombatActor, TargetCombat } from "../../../src/sim/combat-contract.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { WorldGameplayAnchor } from "../../../src/sim/gameplay-world.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { repairTravel } from "../../../src/sim/agents/repair-travel.ts";

const actor: CombatActor = { id: "agent:1", kind: "robot", firmware: "good", model: "footman", x: 1, y: 0, z: 0, radius: .4, height: 1.8, heading: 0, speed: 0 };
const kiosk = (id = "repair", x = 20, z = 0): WorldGameplayAnchor => ({ id, kind: "repair-kiosk", x, y: 0, z, roadNodeId: "b", districtId: "test" });
function target(): TargetCombat {
  const state = createCombatState(1, { actors: [actor], players: [], walls: [], refills: [] }, 0);
  return { ...state.targets[actor.id]!, rust: .3, repair: true };
}
function world(anchors: WorldGameplayAnchor[] = [kiosk()]) {
  return buildWorld([], null, null, { version: 1, world: "test", sourceSnapshot: "authored-test", anchors, refills: [], tiles: [], territories: [] });
}
const graph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 20, z: 0 }],
  edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", points: [[0, 0], [20, 0]] }] });

describe("good-robot repair travel", () => {
  it("overrides errands only for a good robot's actual repair state", () => {
    expect(repairTravel(world(), actor, undefined, graph)).toMatchObject({ status: "inactive", movement: null });
    expect(repairTravel(world(), actor, { ...target(), repair: false }, graph)).toMatchObject({ status: "inactive", movement: null });
    expect(repairTravel(world(), { ...actor, firmware: "bad" }, target(), graph)).toMatchObject({ status: "inactive", movement: null });
    expect(repairTravel(world(), actor, target(), graph)).toMatchObject({ status: "travelling", kioskId: "repair",
      movement: { kind: "repair", kioskId: "repair", destination: { x: 20, z: 0 }, stopDistance: 4 } });
  });

  it("holds pending when authored kiosks or accessible route geometry are missing", () => {
    expect(repairTravel(world([]), actor, target(), graph)).toMatchObject({ status: "pending", reason: "missing-kiosk", movement: { kind: "hold" } });
    expect(repairTravel(world([{ ...kiosk(), kind: "car-wash" }]), actor, target(), graph)).toMatchObject({ status: "pending", reason: "missing-kiosk" });
    expect(repairTravel(world(), actor, target(), buildSidewalkGraph({ nodes: [], edges: [] }))).toMatchObject({ status: "pending", reason: "no-safe-route" });
    expect(repairTravel(world([kiosk("mid-edge", 10)]), actor, target(), graph)).toMatchObject({ status: "pending", reason: "no-safe-route" });
  });

  it("chooses the nearest safely reachable authored kiosk and respects directed sidewalks", () => {
    const fork = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 20, z: 0 }, { id: "c", x: 0, z: 40 }], edges: [
      { id: "ab", a: "a", b: "b", kind: "sidewalk", points: [[0, 0], [20, 0]] },
      { id: "ac", a: "a", b: "c", kind: "sidewalk", points: [[0, 0], [0, 40]] },
    ] });
    const blocked = buildWorld([{ tileId: "wall", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10, footprint: [[9, -2], [11, -2], [11, 2], [9, 2]] }] }], null, null,
      { version: 1, world: "test", sourceSnapshot: "authored-test", anchors: [kiosk("near"), kiosk("far", 0, 40)], refills: [], tiles: [], territories: [] });
    expect(repairTravel(blocked, { ...actor, x: 0, z: 1 }, target(), fork)).toMatchObject({ status: "travelling", kioskId: "far" });
    const directed = buildSidewalkGraph({ nodes: graph.nodes, edges: [{ id: "one-way", a: "a", b: "b", kind: "sidewalk", bidirectional: false, points: [[0, 0], [20, 0]] }] });
    expect(repairTravel(world([kiosk("behind", 0)]), { ...actor, x: 18 }, target(), directed)).toMatchObject({ status: "pending", reason: "no-safe-route" });
  });

  it("reports arrival only from current proximity and never completes or clears repair", () => {
    const repair = target(); const snapshot = JSON.stringify(repair);
    expect(repairTravel(world(), actor, repair, graph).status).toBe("travelling");
    expect(repairTravel(world(), { ...actor, x: 17 }, repair, graph)).toMatchObject({ status: "arrived", kioskId: "repair", movement: { kind: "hold" } });
    expect(JSON.stringify(repair)).toBe(snapshot);
    expect(repair.repair).toBe(true);
  });

  it("keeps disabled, occupied and unsupported bodies pending rather than misusing pedestrian movement", () => {
    expect(repairTravel(world(), actor, { ...target(), phase: "seized" }, graph)).toMatchObject({ status: "pending", reason: "inactive-body" });
    expect(repairTravel(world(), { ...actor, occupied: true }, target(), graph)).toMatchObject({ status: "pending", reason: "inactive-body" });
    expect(repairTravel(world(), { ...actor, model: "robotaxi" }, target(), graph)).toMatchObject({ status: "pending", reason: "unsupported-follower" });
  });

  it("is deterministic under authored input order and preserves the caller's JSON", () => {
    const a = kiosk("a"), b = kiosk("b"); const repair = target(); const before = JSON.stringify({ actor, repair });
    expect(repairTravel(world([a, b]), actor, repair, graph)).toEqual(repairTravel(world([b, a]), actor, repair, graph));
    expect(repairTravel(world([a, b]), actor, repair, graph).kioskId).toBe("a");
    expect(JSON.stringify({ actor, repair })).toBe(before);
  });
});
