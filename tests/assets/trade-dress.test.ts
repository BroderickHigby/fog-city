// The trade-dress checklist (tests/assets/trade-dress.json): every robot and vehicle model in
// public/models has an entry with its silhouette and the real products and film robots it was
// compared with, and every entry points at a model that exists.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";
import { loadModel, sceneNodes } from "./glb.ts";

interface Entry {
  model: string;
  name: string;
  silhouette: string;
  nearest: Array<{ what: string; difference: string }>;
  signOff: string;
}

const list = readJson<{ entries: Entry[] }>("tests/assets/trade-dress.json");
const models = readdirSync(join(ROOT, "public", "models")).filter((f) => f.endsWith(".glb"));

/** Robots and vehicles: anything with wheels, a robot extra, or a vehicle extra. */
async function isRobotOrVehicle(file: string): Promise<boolean> {
  const { doc } = await loadModel(file);
  const nodes = sceneNodes(doc);
  const root = nodes[0]!.getExtras();
  if (root.robot || root.vehicle || root.fcActor === "robotaxi" || root.fcActor === "player-car") return true;
  const wheels = nodes.filter((n) => /^wheel_/.test(n.getName())).length;
  const people = root.mobilityAid || root.interact || file === "vendor-cart.glb";
  return wheels >= 4 && !people;
}

describe("trade-dress checklist", () => {
  it("covers every robot and vehicle model", async () => {
    const covered = new Set(list.entries.map((e) => e.model));
    for (const f of models) {
      if (await isRobotOrVehicle(f)) expect(covered, f).toContain(f);
    }
    for (const must of ["errand-robot.glb", "sidewalk-bot.glb", "moat-van.glb", "robotaxi.glb"]) expect(covered).toContain(must);
  });

  it.each(list.entries)("$model: a silhouette, comparisons and a sign-off state", (e) => {
    expect(models).toContain(e.model);
    expect(e.silhouette.length).toBeGreaterThan(40);
    expect(e.nearest.length).toBeGreaterThan(0);
    for (const n of e.nearest) {
      expect(n.what.length).toBeGreaterThan(5);
      expect(n.difference.length).toBeGreaterThan(10);
    }
    expect(e.signOff.length).toBeGreaterThan(0);
  });
});
