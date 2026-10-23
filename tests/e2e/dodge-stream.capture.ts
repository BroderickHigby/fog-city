// Frame strips of people getting out of a car's way (tests/e2e/dodge-stream.config.ts). For each
// speed: a second player joins 70 m behind someone walking near the SF spawn, on their path, and
// drives at them (steering at them every tick, holding the speed); once they start to dodge, a camera 8 m to
// the side of them films a frame every few ticks. Writes <DODGE_SHOTS>/<speed>-<n>.png and
// <DODGE_SHOTS>/<speed>.json (the person's sim trace: position, height, dodge phase).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { bootWorld, frames, gateWorld, type FogWindow } from "./fixtures.ts";

const OUT = process.env.DODGE_SHOTS ?? "test-results/dodge-stream";
const SPEEDS = (process.env.DODGE_SPEEDS ?? "8,14,22").split(",").map(Number);
const SHOTS = 16;
const EVERY = 4;

interface Picked {
  id: number;
  found: boolean;
  ticks: number;
  car: { x: number; z: number; heading: number; speed: number };
  person: { x: number; y: number; z: number };
}

for (const speed of SPEEDS) {
  test(`a car at ${speed} m/s driven at a pedestrian`, async ({ page }) => {
    gateWorld("sf");
    await bootWorld(page, "sf", "&radius=250&pr=1", 240_000);
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled?.() !== false, null, { timeout: 240_000 });
    // Drive at the nearest person ahead until they start to dodge.
    const picked: Picked = await page.evaluate((target) => {
      const game = (window as unknown as FogWindow).__fogcity!;
      game.pause();
      type A = { id: number; kind: string; x: number; y: number; z: number; heading: number; speed: number; dodge: unknown };
      const agents = (): A[] => ((game.state().ext as Record<string, { list?: A[] }>).agents?.list ?? []) as A[];
      const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
      // A walking adult 40-160 m from the spawn (people walk along pavements: the line behind
      // them along their path is clear of buildings).
      game.stepN(120);
      const home = game.state().players.p1!.car;
      const people = agents().filter((a) => a.kind === "person" && !a.dodge && Math.hypot(a.x - home.x, a.z - home.z) > 30 && Math.hypot(a.x - home.x, a.z - home.z) < 250);
      const pick = people.filter((a) => a.speed > 0.5).sort((a, b) => a.id - b.id)[0] ?? people.sort((a, b) => a.id - b.id)[0];
      if (!pick) throw new Error("nobody walking near the spawn");
      const id = pick.id;
      const back = 70;
      const join = { tick: game.state().tick + 1, kind: "player.join", playerId: "j1", payload: { x: pick.x - Math.sin(pick.heading) * back, z: pick.z + Math.cos(pick.heading) * back, heading: pick.heading } };
      game.stepFrames!([{}], [join]);
      const car = () => game.state().players.j1!.car;
      let ticks = 0;
      for (; ticks < 1800; ticks++) {
        const p = agents().find((a) => a.id === id);
        if (!p || p.dodge) break;
        const c = car();
        const err = wrap(Math.atan2(p.x - c.x, -(p.z - c.z)) - c.heading);
        game.stepFrames!([{ j1: { throttle: c.speed < target ? 1 : 0, steer: Math.max(-1, Math.min(1, err * 3)), brake: c.speed > target + 1 ? 1 : 0, actions: 0 } }]);
      }
      const p = agents().find((a) => a.id === id)!;
      const c = car();
      return { id, found: Boolean(p?.dodge), ticks, car: { x: c.x, z: c.z, heading: c.heading, speed: c.speed }, person: { x: p.x, y: p.y, z: p.z } };
    }, speed);
    mkdirSync(OUT, { recursive: true });
    // The camera: 8 m to the side of the person, square to the car's line, at eye height, looking at them.
    const side = { x: Math.cos(picked.car.heading), z: Math.sin(picked.car.heading) };
    const cam = { x: picked.person.x + side.x * 8, y: picked.person.y + 1.5, z: picked.person.z + side.z * 8 };
    const yaw = (Math.atan2(picked.person.x - cam.x, -(picked.person.z - cam.z)) * 180) / Math.PI;
    await page.evaluate(([x, y, z, yw]) => (window as unknown as FogWindow).__fogcity!.flyTo!(x!, y!, z!, yw!, -6), [cam.x, cam.y, cam.z, yaw]);
    await frames(page, 6);
    const trace: unknown[] = [];
    for (let k = 0; k < SHOTS; k++) {
      await page.screenshot({ path: join(OUT, `${speed}-${String(k).padStart(2, "0")}.png`), clip: { x: 300, y: 150, width: 500, height: 420 } });
      const row = await page.evaluate(
        ([id, target, every]) => {
          const game = (window as unknown as FogWindow).__fogcity!;
          type A = { id: number; x: number; y: number; z: number; heading: number; mode: string; dodge: { phase: string; hop: number; leap: boolean } | null };
          const rows: unknown[] = [];
          for (let i = 0; i < every!; i++) {
            const c = game.state().players.j1!.car;
            const list = ((game.state().ext as Record<string, { list?: A[] }>).agents?.list ?? []) as A[];
            const p = list.find((a) => a.id === id);
            const err = p ? Math.atan2(Math.sin(Math.atan2(p.x - c.x, -(p.z - c.z)) - c.heading), Math.cos(Math.atan2(p.x - c.x, -(p.z - c.z)) - c.heading)) : 0;
            game.stepFrames!([{ j1: { throttle: c.speed < target! ? 1 : 0, steer: Math.max(-1, Math.min(1, err * 3)), brake: 0, actions: 0 } }]);
            const q = ((game.state().ext as Record<string, { list?: A[] }>).agents?.list ?? []).find((a) => (a as A).id === id) as A | undefined;
            if (q) rows.push({ tick: game.state().tick, x: q.x, y: q.y, z: q.z, heading: q.heading, mode: q.mode, phase: q.dodge?.phase ?? null, hop: q.dodge?.hop ?? 0, leap: q.dodge?.leap ?? false });
          }
          return rows;
        },
        [picked.id, speed, EVERY] as const,
      );
      trace.push(...row);
      await frames(page, 3);
    }
    writeFileSync(join(OUT, `${speed}.json`), JSON.stringify({ speed, picked, camera: cam, everyTicks: EVERY, trace }, null, 1) + "\n");
  });
}
