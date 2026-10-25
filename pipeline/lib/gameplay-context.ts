import type { TileRef } from "./config.ts";
import type { Ground } from "./terrain.ts";
import { pointInRing, type P2 } from "./geom.ts";

type Footprint = { footprint: readonly P2[] };

/** Shared by full generation and re-indexing, including exact tile-edge ownership. */
export function gameplayLand(
  tiles: readonly Pick<TileRef, "ix" | "iz">[],
  size: number,
  ground: Pick<Ground, "heightAt" | "waterAt"> & Partial<Pick<Ground, "field">>,
  buildings: readonly Footprint[],
  lakeMasks: ReadonlyMap<string, readonly number[]> = new Map(),
): (x: number, z: number) => boolean {
  const ids = new Set(tiles.map(t => `${t.ix},${t.iz}`));
  const cells = new Map<string, Footprint[]>();
  for (const building of buildings) {
    const xs = building.footprint.map(p => p[0]), zs = building.footprint.map(p => p[1]);
    for (let x = Math.floor(Math.min(...xs) / 50); x <= Math.floor(Math.max(...xs) / 50); x++) {
      for (let z = Math.floor(Math.min(...zs) / 50); z <= Math.floor(Math.max(...zs) / 50); z++) {
        const key = `${x},${z}`, list = cells.get(key) ?? [];
        list.push(building);
        cells.set(key, list);
      }
    }
  }
  const lakeAt = (x: number, z: number): boolean => {
    const mask = lakeMasks.get(`t${Math.floor(x / size)}_${Math.floor(z / size)}`);
    const field = mask && ground.field?.(x, z);
    if (!mask || !field) return false;
    const ix = Math.min(field.nx - 1, Math.max(0, Math.round((x - field.x0) / field.cellSizeM)));
    const iz = Math.min(field.nz - 1, Math.max(0, Math.round((z - field.z0) / field.cellSizeM)));
    return mask[iz * field.nx + ix] === 1;
  };
  return (x, z) => Number.isFinite(x) && Number.isFinite(z)
    && ids.has(`${Math.floor(x / size)},${Math.floor(z / size)}`)
    && ground.heightAt(x, z) !== null && !ground.waterAt(x, z) && !lakeAt(x, z)
    && !(cells.get(`${Math.floor(x / 50)},${Math.floor(z / 50)}`) ?? []).some(b => pointInRing(x, z, b.footprint));
}

function after<T>(input: Record<string, T>, key: string, values: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  let added = false;
  for (const [name, value] of Object.entries(input)) {
    if (Object.hasOwn(values, name)) continue;
    result[name] = value;
    if (name === key) {
      Object.assign(result, values);
      added = true;
    }
  }
  if (!added) Object.assign(result, values);
  return result;
}

/** JSON key order is part of the byte-identical generated artifact. */
export function gameplayMetadata(
  layers: Record<string, string>, counts: Record<string, number>,
  gameplay: { refills: readonly unknown[]; anchors: readonly unknown[] },
): { layers: Record<string, string>; counts: Record<string, number> } {
  return {
    layers: after(layers, "transit", { gameplay: "gameplay.json" }),
    counts: after(counts, "transitStops", { gameplayRefills: gameplay.refills.length, gameplayAnchors: gameplay.anchors.length }),
  };
}
