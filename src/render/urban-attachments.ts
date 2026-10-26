// Original SF facade fixtures using Slop New York's spatially pooled architectural-detail
// procedure. Only existing wall frames and floor/column spacing select their placement.
import type { BuildingCharacter, CharacterWall } from "./building-character.ts";
import type { RGB } from "./tile-geometry.ts";
import { srgb } from "./tile-geometry.ts";

export interface WallPoint { along: number; y: number; out: number }
export interface AttachmentEmitter {
  box(wall: CharacterWall, at: WallPoint, width: number, height: number, depth: number, color: RGB): boolean;
  beam(wall: CharacterWall, from: WallPoint, to: WallPoint, width: number, color: RGB): boolean;
}
const IRON = srgb(0x343c3e), GRILLE = srgb(0x586164), VENT = srgb(0x9c9a87);
const CLOTH = [0x456650, 0x844e40, 0x7e7650, 0x3d5769, 0x6b675e].map(srgb);
const CANVAS = srgb(0xc3baa0);

/** Components are emitted before small trim so the fixed per-building budget preserves a silhouette. */
export function addFacadeAttachments(
  b: Readonly<BuildingCharacter>, walls: readonly CharacterWall[], floorH: number,
  colW: number, win: readonly number[], emit: AttachmentEmitter,
): void {
  const eligible = walls.filter(w => Math.hypot(w.bx - w.ax, w.bz - w.az) > 7 && w.top - w.bottom > 6);
  const main = eligible[0];
  if (!main) return;
  const len = Math.hypot(main.bx - main.ax, main.bz - main.az);

  // An unbranded fabric awning has a shallow canopy, a hanging valance and metal supports.
  // It remains above a person's head, with the emitter also checking local terrain clearance.
  if (b.height > 7 && b.seed > .08) {
    const width = Math.min([3.4, 3.2, 3.6, 2.8, 3.8][b.family]!, len * .30), along = len * (.40 + b.seed * .20);
    const y = b.baseY + 3.78, cloth = CLOTH[b.family]!;
    emit.box(main, { along, y, out: .43 }, width, .14, .88, cloth);
    for (let stripe = 0; stripe < 5; stripe++) {
      if (stripe % 2 === 0) emit.box(main, { along: along + (stripe - 2) * width / 5, y: y + .075, out: .43 }, width / 5 * .96, .018, .88, CANVAS);
    }
    emit.box(main, { along, y: y - .13, out: .84 }, width, .22, .055, cloth);
    for (const side of [-1, 1]) emit.beam(main,
      { along: along + side * width * .44, y: y - .32, out: .02 },
      { along: along + side * width * .44, y: y - .03, out: .77 }, .045, IRON);
  }

  // Sparse window air conditioners belong to older masonry/residential/industrial walls.
  // The casing and real raised louvers remain legible when seen obliquely from the sidewalk.
  if (b.family === 0 || b.family === 2 || b.family === 3) {
    for (const wall of eligible.slice(0, 2)) {
      const wallLen = Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
      let units = 0;
      for (let floor = 1; floor < Math.min(5, b.height / floorH - 1); floor++) {
        for (let n = 0; n < 3; n++) {
          const cell = Math.ceil(wall.u0 / colW) + n * 2 + Math.floor(b.seed * 2);
          const center = (cell + .5) * colW;
          const along = (center - wall.u0) / (wall.u1 - wall.u0) * wallLen;
          const y = b.baseY + (floor + win[2]!) * floorH - .26;
          if (along < .85 || along > wallLen - .85 || y + .22 > wall.top - .8 || units >= 4) continue;
          if ((floor + n + Math.floor(b.seed * 17)) % 3 !== 0) continue;
          if (!emit.box(wall, { along, y, out: .23 }, .76, .43, .48, VENT)) continue;
          emit.box(wall, { along, y, out: .48 }, .66, .32, .025, IRON);
          for (let bar = 0; bar < 4; bar++) emit.box(wall, { along, y: y - .12 + bar * .08, out: .50 }, .65, .022, .024, GRILLE);
          units++;
        }
      }
    }
  }

  // SF walk-ups and older industrial blocks have occasional open iron escapes. No stairs or
  // dropped ladders reach pedestrian level; this changes the facade, never the collision map.
  const canEscape = b.family !== 4 && b.family !== 1 && b.height >= 10 && b.height <= 43 && b.seed > .18;
  if (!canEscape) return;
  const wall = eligible[Math.floor(b.seed * eligible.length) % Math.min(2, eligible.length)]!;
  const wallLen = Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
  const center = Math.max(1.8, Math.min(wallLen - 1.8, wallLen * (.38 + b.seed * .22)));
  const first = 2, last = Math.min(6, Math.floor((b.height - 2) / floorH));
  if (last < first) return;
  for (let floor = first; floor <= last; floor++) {
    const y = b.baseY + floor * floorH + win[2]! * floorH - .06;
    if (y + 1.05 > wall.top - .35) break;
    if (!emit.box(wall, { along: center, y, out: .49 }, 2.6, .07, .96, IRON)) continue;
    // Thin rails and pickets leave the landings open instead of making dark balcony boxes.
    for (const out of [.09, .93]) {
      emit.box(wall, { along: center, y: y + .94, out }, 2.6, .045, .045, IRON);
      emit.box(wall, { along: center, y: y + .47, out }, 2.6, .028, .028, IRON);
    }
    for (let n = 0; n <= 6; n++) emit.box(wall, { along: center - 1.24 + n * 2.48 / 6, y: y + .48, out: .93 }, .028, .91, .028, IRON);
    for (const side of [-1, 1]) {
      emit.box(wall, { along: center + side * 1.27, y: y + .94, out: .50 }, .045, .045, .87, IRON);
      emit.beam(wall, { along: center + side * 1.15, y: y - .50, out: .02 }, { along: center + side * 1.15, y: y - .06, out: .85 }, .055, IRON);
    }
    if (floor === last) continue;
    const direction = floor % 2 === 0 ? 1 : -1;
    for (let step = 0; step < 10; step++) {
      const t = (step + .5) / 10;
      emit.box(wall, { along: center + direction * (-1.03 + t * 2.06), y: y + t * floorH, out: .48 }, .24, .05, .66, GRILLE);
    }
    for (const out of [.13, .83]) {
      const from = { along: center - direction * 1.11, y: y + .10, out };
      const to = { along: center + direction * 1.11, y: y + floorH + .10, out };
      emit.beam(wall, from, to, .055, IRON);
      emit.beam(wall, { ...from, y: from.y + .86 }, { ...to, y: to.y + .86 }, .04, IRON);
    }
  }
}
