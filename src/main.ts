// Boot: load a world manifest, build the sim world, run a fixed-timestep loop and render
// interpolated poses. ?world=dev (default) | ?world=sf once the pipeline has produced it.

import { Keyboard } from "./input/keyboard.ts";
import { SceneRenderer } from "./render/scene.ts";
import {
  DT,
  buildWorld,
  createInitialState,
  hashState,
  sortedIds,
  step,
  wrapAngle,
  type SimInput,
  type SimState,
  type TileCollider,
} from "./sim/index.ts";
import { installDebugHandle } from "./debug.ts";

interface Manifest {
  version: number;
  world: string;
  spawn: { x: number; z: number; heading: number };
  tiles: Array<{ id: string; collider: string; glb: string | null }>;
}

const LOCAL_PLAYER = "p1";
const MAX_FRAME_S = 0.25;

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const worldName = params.get("world") ?? "dev";
  const base = `/tiles/${worldName}/`;
  const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
  const tiles = await Promise.all(
    manifest.tiles.map(async (t) => (await (await fetch(base + t.collider)).json()) as TileCollider),
  );
  const world = buildWorld(tiles);

  const container = document.getElementById("game")!;
  const hud = document.getElementById("hud")!;
  const view = new SceneRenderer(container);
  for (const t of world.tiles) view.addTile(t);

  const keyboard = new Keyboard();
  let prev: SimState = createInitialState(world, 1, [LOCAL_PLAYER], manifest.spawn);
  let curr: SimState = prev;
  let paused = false;
  let acc = 0;
  let last = performance.now();

  const advance = (input: SimInput): void => {
    prev = curr;
    curr = step(world, curr, { [LOCAL_PLAYER]: input });
  };

  installDebugHandle({
    world: worldName,
    state: () => curr,
    hash: () => hashState(curr),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      last = performance.now();
    },
    stepN: (n, input) => {
      for (let i = 0; i < n; i++) advance(input ?? { throttle: 0, steer: 0, brake: 0, actions: 0 });
    },
  });

  const frame = (now: number): void => {
    const dtFrame = Math.min((now - last) / 1000, MAX_FRAME_S);
    last = now;
    for (const code of keyboard.takeUiPresses()) {
      if (code === "KeyC") view.cameraMode = view.cameraMode === "chase" ? "first-person" : "chase";
    }
    if (!paused) {
      acc += dtFrame;
      while (acc >= DT) {
        advance(keyboard.sample());
        acc -= DT;
      }
    }
    const alpha = paused ? 1 : acc / DT;
    for (const id of sortedIds(curr.players)) {
      const a = (prev.players[id] ?? curr.players[id]!).car;
      const b = curr.players[id]!.car;
      const pose = {
        x: a.x + (b.x - a.x) * alpha,
        y: a.y + (b.y - a.y) * alpha,
        z: a.z + (b.z - a.z) * alpha,
        heading: a.heading + wrapAngle(b.heading - a.heading) * alpha,
      };
      view.setCar(id, pose);
      if (id === LOCAL_PLAYER) view.follow(pose, dtFrame);
    }
    const me = curr.players[LOCAL_PLAYER]?.car;
    if (me) {
      hud.textContent =
        `Fog City · ${worldName}   ${(me.speed * 3.6).toFixed(0)} km/h\n` +
        `x ${me.x.toFixed(1)}  z ${me.z.toFixed(1)}  hits ${me.hits}\n` +
        `WASD drive · Space brake · C camera`;
    }
    view.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
