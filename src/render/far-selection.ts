import type { FarCell } from "./far-layer.ts";

export interface FarBudget { radius: number; retainRadius: number; maxCells: number }

/** Native GPUs retain the full skyline. Only positively identified CPU renderers opt down. */
export function softwareFarBudget(renderer: string): FarBudget | undefined {
  return /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i.test(renderer)
    ? { radius: 6000, retainRadius: 8000, maxCells: 24 } : undefined;
}

export function farCellDistance(cell: FarCell, x: number, z: number): number {
  const b = cell.bbox;
  if (!b || !b.every(Number.isFinite)) return 0;
  const dx = Math.max(Math.min(b[0], b[2]) - x, x - Math.max(b[0], b[2]), 0);
  const dz = Math.max(Math.min(b[1], b[3]) - z, z - Math.max(b[1], b[3]), 0);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Stable nearest-first queue; bounds distance keeps cells touching the viewing region. */
export function selectFarCells(cells: readonly FarCell[], x: number, z: number, radius = Infinity, maxCells = Infinity): FarCell[] {
  return cells.map(cell => ({ cell, distance: farCellDistance(cell, x, z) }))
    .filter(entry => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.cell.id.localeCompare(b.cell.id))
    .slice(0, maxCells).map(entry => entry.cell);
}
