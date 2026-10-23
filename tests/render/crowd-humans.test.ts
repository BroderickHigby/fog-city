// The skinned pedestrian crowd (src/render/crowd-humans.ts): the Rocketbox crowd files load, each
// person keeps one character, at most CROWD_NEAR_MAX are drawn, and unseen bodies are disposed.
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { validateBytes } from "gltf-validator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROWD_FILES, CROWD_FORGET_S, CROWD_NEAR_MAX, CrowdHumans, characterFor } from "../../src/render/crowd-humans.ts";

const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(readFileSync(new URL(`../../public/${path}`, import.meta.url)));
beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => loaded?.(texture));
    return texture;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("crowd characters", () => {
  it("ships every crowd file, each well under the static build's 15 MB per-file budget", () => {
    let total = 0;
    for (const f of CROWD_FILES) {
      const url = new URL(`../../public/${f}`, import.meta.url);
      expect(existsSync(url), f).toBe(true);
      const n = readFileSync(url).byteLength;
      expect(n).toBeLessThan(4_000_000);
      total += n;
    }
    expect(total).toBeLessThan(30_000_000);
  });

  it.each(CROWD_FILES)("%s is valid glTF 2.0 with no errors or warnings", async (f) => {
    const report = await validateBytes(await bytes(f), { maxIssues: 50 });
    expect(report.issues.numErrors).toBe(0);
    expect(report.issues.numWarnings).toBe(0);
  });

  it("gives each person one stable character, spread over the whole crowd", () => {
    const counts = new Array(CROWD_FILES.length).fill(0);
    for (let id = 1; id <= 1200; id++) {
      const c = characterFor(id);
      expect(characterFor(id)).toBe(c);
      counts[c]++;
    }
    for (const n of counts) expect(n).toBeGreaterThan(60);
  });
});

describe("CrowdHumans", () => {
  it("draws the nearest people as skinned bodies, at most CROWD_NEAR_MAX, and forgets unseen ones", async () => {
    const crowd = new CrowdHumans(bytes, false);
    await vi.waitFor(() => expect(crowd.loaded).toBe(CROWD_FILES.length), { timeout: 20_000 });
    crowd.begin(1 / 60);
    let accepted = 0;
    for (let id = 1; id <= CROWD_NEAR_MAX + 6; id++) if (crowd.add(id, id, 0, 0, 0, id % 3 ? 1.3 : 0, 1 / 60)) accepted++;
    crowd.end();
    expect(accepted).toBe(CROWD_NEAR_MAX);
    expect(crowd.drawn).toBe(CROWD_NEAR_MAX);
    const bodies = (): number => { let n = 0; crowd.group.traverse((o) => { if (o.name.startsWith("player-body:")) n++; }); return n; };
    expect(bodies()).toBe(CROWD_NEAR_MAX);
    let skinned = 0;
    crowd.group.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.parent?.visible !== false) skinned++; });
    expect(skinned).toBeGreaterThan(0);
    // Nobody seen for longer than CROWD_FORGET_S: every body is disposed.
    for (let t = 0; t < CROWD_FORGET_S + 2; t++) { crowd.begin(1); crowd.end(); }
    expect(bodies()).toBe(0);
    crowd.dispose();
  }, 60_000);

  it("draws nobody until a character has loaded, so the caller keeps the procedural person", () => {
    const crowd = new CrowdHumans(() => new Promise(() => {}), false);
    crowd.begin(1 / 60);
    expect(crowd.add(1, 0, 0, 0, 0, 0, 1 / 60)).toBe(false);
    crowd.end();
    crowd.dispose();
  });
});
