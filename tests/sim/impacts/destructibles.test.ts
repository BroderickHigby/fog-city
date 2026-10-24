// Destructible street props (props.ts, impacts.ts): the sim's trees and lamp posts are exactly the
// renderer's; a sapling cannot stop a car, a young tree or a lamp post breaks only when hit fast,
// a mature tree never breaks (the car bounces off it and is dented); a falling prop only leans
// when anyone is where it would land; broken props stay broken and come back once nobody has been
// near for a while; hydrants are knocked off their base. Deterministic.
import { describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  PROP_RESET_TICKS,
  carDamage,
  createInitialState,
  impactsOf,
  propBroken,
  propKnock,
  makeCar,
  propIndex,
  propsFromStreetDetail,
  propsNear,
  step,
  stepImpacts,
  type AgentState,
  type AgentsExt,
  type Prop,
  type RoadsFile,
  type SimInput,
  type SimState,
  type World,
} from "../../../src/sim/index.ts";
import { nodeClearance, streetTreeSpots, streetlightSpots } from "../../../src/render/roads.ts";
import type { RoadEdge } from "../../../src/render/types.ts";
import { loadWorld, readJson, readJsonIfExists, worldExists } from "../../helpers.ts";
import type { StreetDetailIndex } from "../../../src/io/world-load.ts";
import { LONG_RUN_MS, gridCity } from "../fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });

function parity(name: string): void {
  const { world, roads } = loadWorld(name, { roads: true });
  const edges = (roads as unknown as RoadsFile).edges as unknown as RoadEdge[];
  const clearance = nodeClearance({ edges });
  // With World detail's street trees (street-detail.json) the renderer draws those instead of
  // its road-graph trees (foliage.ts setPlacements), so the sim's trees are those, at the file's x, z.
  const detail = readJsonIfExists<StreetDetailIndex>(`public/tiles/${name}/street-detail.json`);
  const real = detail?.layers?.trees ? readJson<{ trees: Array<[number, number, number, number, number]> }>(`public/tiles/${name}/${detail.layers.trees}`).trees : null;
  const drawn = [
    ...(real ? real.map(([, x, z]) => ({ x, z })) : streetTreeSpots(edges, clearance)).map((s) => ["tree", s.x, s.z] as const),
    ...streetlightSpots(edges, clearance).map((s) => ["lamp", s.x, s.z] as const),
  ];
  if (real) expect(propIndex(world).list.some((p) => p.kind === "tree" && p.id.split(":").length > 2), `${name}: no road-graph trees`).toBe(false);
  const sim = propIndex(world).list.filter((p) => p.kind === "tree" || p.kind === "lamp");
  expect(sim.length, name).toBe(drawn.length);
  // Every drawn prop has a sim prop of its kind within a millimetre.
  for (const [kind, x, z] of drawn) {
    const near = propsNear(world, x, z, 0.001).filter((p) => p.kind === kind);
    expect(near.length, `${name} ${kind} at ${x}, ${z}`).toBeGreaterThan(0);
  }
}

describe("the sim's props are the renderer's", () => {
  it.skipIf(!worldExists("sf"))("sf: World detail's signal poles, stop signs and sign posts are props with their ids", () => {
    const { world } = loadWorld("sf", { roads: true });
    const idx = propIndex(world);
    const furniture = readJson<{ signals: Array<{ id: string; x: number; z: number }>; stopSigns: Array<{ id: string }> }>("public/tiles/sf/street-furniture.json");
    const sig = furniture.signals[0]!;
    expect(idx.byId.get(sig.id)).toMatchObject({ kind: "signal", x: sig.x, z: sig.z });
    expect(idx.byId.get(furniture.stopSigns[0]!.id)?.kind).toBe("sign");
  }, 120_000);
  it("dev-city", () => parity("dev-city"));
  it.skipIf(!worldExists("sf"))("sf (the whole city)", () => parity("sf"), 120_000);
});

/** A grid-city state with player "p" in a car `back` m west of `prop`, facing it (east), at `speed`; nobody else about. */
function aimAt(world: World, prop: Prop, back: number, speed: number, people: AgentState[] = []): SimState {
  const s0 = createInitialState(world, 5, ["p"], { x: 150, z: -40, heading: 0 });
  const car = { ...makeCar(prop.x - back, prop.z, Math.PI / 2), speed };
  const ext = s0.ext[AGENTS_EXT_KEY] as AgentsExt;
  return { ...s0, players: { p: { ...s0.players.p!, car } }, ext: { ...s0.ext, [AGENTS_EXT_KEY]: { ...ext, list: people } } };
}

/** A prop of the kind wanted with a clear run at it from the west (no other prop in the car's way, no building). */
function pick(world: World, want: (p: Prop) => boolean): Prop {
  const p = propIndex(world).list.find((q) => want(q) && propsNear(world, q.x - 5, q.z, 6).every((o) => o.id === q.id || Math.abs(o.z - q.z) > 1.6 || o.x > q.x + 0.5));
  expect(p).toBeDefined();
  return p!;
}

function drive(world: World, s: SimState, ticks: number, input = I(0)): SimState[] {
  const out = [s];
  for (let t = 0; t < ticks; t++) out.push(step(world, out[out.length - 1]!, { p: input }));
  return out;
}

describe("hitting street props", () => {
  const world = gridCity();

  it("a sapling cannot stop a car: it snaps and the car barely slows", () => {
    const p = pick(world, (q) => q.size === "sapling");
    const states = drive(world, aimAt(world, p, 5, 9), 60);
    const end = states[states.length - 1]!;
    expect(impactsOf(end)!.props![p.id]!.state).toBe("snapped");
    expect(end.players.p!.car.x).toBeGreaterThan(p.x + 3);
    expect(end.players.p!.car.speed).toBeGreaterThan(7);
  });

  it("a young tree breaks only when hit fast; slower it holds the car like a wall", () => {
    const p = pick(world, (q) => q.size === "young");
    const fast = drive(world, aimAt(world, p, 5, 12), 60);
    const k = impactsOf(fast[fast.length - 1]!)!.props![p.id]!;
    expect(k.state).toBe("fallen");
    // The read-only accessors renderers use.
    expect(propKnock(fast[fast.length - 1]!, p.id)).toEqual(k);
    expect(propBroken(fast[fast.length - 1]!, p.id)).toBe(true);
    // It fell the way it was hit (east, bearing pi/2).
    expect(Math.abs(k.dir - Math.PI / 2)).toBeLessThan(0.3);
    const slow = drive(world, aimAt(world, p, 5, 4), 90);
    const end = slow[slow.length - 1]!;
    expect(impactsOf(end)?.props?.[p.id]).toBeUndefined();
    expect(propKnock(end, p.id)).toBeUndefined();
    expect(end.players.p!.car.x).toBeLessThan(p.x - 2);
    expect(impactsOf(end)!.events.some((e) => e.kind === "car-prop" && e.broke === false)).toBe(true);
  });

  it("a mature tree never breaks: the car bounces off it, dented", () => {
    const p = pick(world, (q) => q.size === "mature");
    const states = drive(world, aimAt(world, p, 5, 20), 60);
    const end = states[states.length - 1]!;
    expect(impactsOf(end)?.props?.[p.id]).toBeUndefined();
    expect(end.players.p!.car.x).toBeLessThan(p.x - 2);
    const hit = states.findIndex((x) => (impactsOf(x)?.events.length ?? 0) > 0);
    expect(states[hit]!.players.p!.car.speed).toBeLessThan(0.5);
    expect(carDamage(end, "p").front).toBeGreaterThan(0.5);
    expect(carDamage(end, "p").condition).toBeLessThan(70);
  });

  it("a falling tree only leans when someone is where it would land", () => {
    // (Driven at, a bystander dives clear before the hit, so the tree falls; here the hit is
    // handed to impacts.ts directly with someone standing in the fall line.)
    const p = pick(world, (q) => q.size === "young");
    const s0 = aimAt(world, p, 3, 0);
    const someone = (createInitialState(world, 5, ["p"], { x: 150, z: -40, heading: 0 }).ext[AGENTS_EXT_KEY] as AgentsExt).list.find((a) => a.kind === "person")!;
    const hit = (people: AgentState[]): string => {
      const s = { ...s0, tick: s0.tick + 1, ext: { ...s0.ext, [AGENTS_EXT_KEY]: { ...(s0.ext[AGENTS_EXT_KEY] as AgentsExt), list: people } } };
      // The car hit it heading east: the impulse on the car points west (nx -1).
      const contact = { key: `prop:${p.id}`, j: 3000, nx: -1, nz: 0, jt: 0, tx: 0, tz: -1, x: p.x - p.r, z: p.z, speed: 12 };
      return impactsOf(stepImpacts(world, s, new Map([["p", [contact]]])))!.props![p.id]!.state;
    };
    expect(hit([])).toBe("fallen");
    expect(hit([{ ...someone, x: p.x + 4, z: p.z + 0.5 }])).toBe("leaning");
    // Someone well off to the side is no reason to hold it up.
    expect(hit([{ ...someone, x: p.x + 4, z: p.z + 4 }])).toBe("fallen");
  });

  it("a hydrant is knocked off its base", () => {
    const gameplayWorld = { ...world, gameplay: { ...(world.gameplay ?? {}), refills: [{ id: "h1", kind: "hydrant", x: 210, y: 0, z: 7.3, radius: 2, salt: false }] } } as unknown as World;
    const p = propIndex(gameplayWorld).byId.get("hydrant:h1")!;
    expect(p).toBeDefined();
    const states = drive(gameplayWorld, aimAt(gameplayWorld, p, 5, 6), 60);
    expect(impactsOf(states[states.length - 1]!)!.props!["hydrant:h1"]!.state).toBe("knocked");
  });

  it("broken props stay broken, and come back once nobody has been near for a while", () => {
    const p = pick(world, (q) => q.size === "sapling");
    let s = drive(world, aimAt(world, p, 5, 9), 30).at(-1)!;
    expect(impactsOf(s)!.props![p.id]).toBeDefined();
    // Parked right there: it stays broken however long.
    s = { ...s, tick: s.tick + PROP_RESET_TICKS, players: { p: { ...s.players.p!, car: { ...s.players.p!.car, speed: 0, lateral: 0 } } } };
    s = drive(world, s, 2, I(0, 0, 1)).at(-1)!;
    expect(impactsOf(s)!.props![p.id]).toBeDefined();
    // Gone far away: the crews put it back.
    s = { ...s, players: { p: { ...s.players.p!, car: { ...s.players.p!.car, x: p.x + 250, z: p.z } } } };
    s = drive(world, s, 2, I(0, 0, 1)).at(-1)!;
    expect(impactsOf(s)!.props![p.id]).toBeUndefined();
  }, LONG_RUN_MS);

  it("is deterministic", () => {
    const p = pick(world, (q) => q.size === "young");
    const a = drive(world, aimAt(world, p, 5, 12), 80).at(-1)!;
    const b = drive(world, aimAt(world, p, 5, 12), 80).at(-1)!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("World detail's props (street-trees.json, street-furniture.json, street-signs.json)", () => {
  const files = {
    trees: { classes: ["broadleaf", "conifer", "palm"], trees: [[1, 10, 5, 1, 3.2], [3, 20, 5, 0, 6.8], [4, 30, 5, 2, 12]] as Array<[number, number, number, number, number]> },
    furniture: { signals: [{ id: "sig:n1:c2", x: 40, z: 5 }], stopSigns: [{ id: "stop:n1:c3", x: 50, z: 5 }] },
    signs: { corners: [{ id: "corner:n1:0", x: 60, z: 5 }], curb: [{ id: "curb:7", x: 70, z: 5 }] },
  };
  it("keep their ids, size trees by height and replace the road-graph trees", () => {
    const world = gridCity();
    const placed = propsFromStreetDetail(files);
    expect(placed.map((p) => p.id)).toEqual(["tree:1", "tree:3", "tree:4", "sig:n1:c2", "stop:n1:c3", "corner:n1:0", "curb:7"]);
    const withDetail = Object.assign(Object.create(Object.getPrototypeOf(world)), world, { props: placed }) as World;
    const idx = propIndex(withDetail);
    expect(idx.byId.get("tree:1")!.size).toBe("sapling");
    expect(idx.byId.get("tree:3")!.size).toBe("young");
    expect(idx.byId.get("tree:4")!.size).toBe("mature");
    expect(idx.byId.get("sig:n1:c2")!.kind).toBe("signal");
    expect(idx.byId.get("curb:7")!.breakSpeed).toBeLessThan(3);
    // Only the real trees: the road-graph ones are gone, the lamp posts stay.
    const trees = idx.list.filter((p) => p.kind === "tree");
    expect(trees.map((p) => p.id).sort()).toEqual(["tree:1", "tree:3", "tree:4"]);
    expect(idx.list.some((p) => p.kind === "lamp")).toBe(true);
    expect(propIndex(world).list.some((p) => p.id.startsWith("tree:h"))).toBe(true);
  });
});
