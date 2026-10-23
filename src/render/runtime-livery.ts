export const RUNTIME_LIVERY_WIDTH = 2048;
export const RUNTIME_LIVERY_HEIGHT = Math.round(RUNTIME_LIVERY_WIDTH / (4.22 / 0.74));
export const RUNTIME_LIVERY_COPY = ["MOAT LABS", "EVERY ERRAND.", "AN OPPORTUNITY.", "TERMS APPLY"] as const;

// Original geometric lettering, authored as strokes rather than an external font or image.
const GLYPHS: Readonly<Record<string, readonly (readonly number[])[]>> = {
  A: [[0, 8, 3, 0, 6, 8], [1.1, 5.2, 4.9, 5.2]],
  B: [[0, 8, 0, 0, 4.3, 0, 6, 1.5, 6, 2.5, 4.3, 4, 0, 4], [4.3, 4, 6, 5.5, 6, 6.5, 4.3, 8, 0, 8]],
  D: [[0, 8, 0, 0, 3.5, 0, 6, 2.2, 6, 5.8, 3.5, 8, 0, 8]],
  E: [[6, 0, 0, 0, 0, 8, 6, 8], [0, 4, 4.7, 4]],
  I: [[3, 0, 3, 8]],
  L: [[0, 0, 0, 8, 6, 8]],
  M: [[0, 8, 0, 0, 3, 4, 6, 0, 6, 8]],
  N: [[0, 8, 0, 0, 6, 8, 6, 0]],
  O: [[1.8, 0, 4.2, 0, 6, 1.8, 6, 6.2, 4.2, 8, 1.8, 8, 0, 6.2, 0, 1.8, 1.8, 0]],
  P: [[0, 8, 0, 0, 4.3, 0, 6, 1.5, 6, 2.5, 4.3, 4, 0, 4]],
  R: [[0, 8, 0, 0, 4.3, 0, 6, 1.5, 6, 2.5, 4.3, 4, 0, 4], [3.3, 4, 6, 8]],
  S: [[6, 0, 1.5, 0, 0, 1.5, 0, 2.5, 1.5, 4, 4.5, 4, 6, 5.5, 6, 6.5, 4.5, 8, 0, 8]],
  T: [[0, 0, 6, 0], [3, 0, 3, 8]],
  U: [[0, 0, 0, 6.2, 1.8, 8, 4.2, 8, 6, 6.2, 6, 0]],
  V: [[0, 0, 3, 8, 6, 0]],
  Y: [[0, 0, 3, 4, 6, 0], [3, 4, 3, 8]],
  ".": [[3, 7.9, 3, 8]],
};
/** Original outline strokes shared by native livery and close-range geometric signs. */
export function runtimeLetterStrokes(letter: string): readonly (readonly number[])[] { return GLYPHS[letter] ?? []; }
type Ink = readonly [number, number, number];

/** Native rasterization keeps the small legal line and large brand strokes equally crisp. */
export function runtimeLiveryPixels(): { width: number; height: number; data: Uint8Array } {
  const width = RUNTIME_LIVERY_WIDTH, height = RUNTIME_LIVERY_HEIGHT, data = new Uint8Array(width * height * 4);
  const white: Ink = [238, 243, 236], teal: Ink = [68, 205, 190], muted: Ink = [153, 188, 185];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, glow = Math.max(0, 1 - Math.hypot((x - 1630) / 650, (y - 160) / 340));
    data[offset] = Math.round(18 + glow * 6); data[offset + 1] = Math.round(31 + glow * 19);
    data[offset + 2] = Math.round(36 + glow * 18); data[offset + 3] = 255;
  }
  function line(x0: number, y0: number, x1: number, y1: number, stroke: number, ink: Ink): void {
    const half = stroke / 2, dx = x1 - x0, dy = y1 - y0, length2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1)); y <= Math.min(height - 1, Math.ceil(Math.max(y0, y1) + half + 1)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1)); x <= Math.min(width - 1, Math.ceil(Math.max(x0, x1) + half + 1)); x++) {
        const t = length2 ? Math.max(0, Math.min(1, ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / length2)) : 0;
        const coverage = Math.max(0, Math.min(1, half + 0.5 - Math.hypot(x + 0.5 - x0 - t * dx, y + 0.5 - y0 - t * dy)));
        if (!coverage) continue;
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(data[offset + channel]! * (1 - coverage) + ink[channel]! * coverage);
      }
    }
  }
  function path(points: readonly number[], x: number, y: number, sx: number, sy: number, stroke: number, ink: Ink): void {
    for (let index = 2; index < points.length; index += 2) line(x + points[index - 2]! * sx, y + points[index - 1]! * sy,
      x + points[index]! * sx, y + points[index + 1]! * sy, stroke, ink);
  }
  function type(copy: string, x: number, y: number, size: number, ink: Ink, weight = 0.09): void {
    for (const letter of copy) {
      if (letter === " ") { x += size * 0.46; continue; }
      for (const points of GLYPHS[letter] ?? []) path(points, x, y, size * 0.105, size / 8, size * weight, ink);
      x += size * 0.82;
    }
  }
  line(60, 42, 60, 312, 9, teal);
  type(RUNTIME_LIVERY_COPY[0], 112, 65, 85, white, 0.085);
  type(RUNTIME_LIVERY_COPY[1], 116, 198, 32, teal);
  type(RUNTIME_LIVERY_COPY[2], 116, 253, 32, white);
  line(1238, 64, 1238, 291, 1.5, muted);
  // The original castle-and-moat mark echoes the company's graphite/teal art direction.
  path([0, 8, 0, 2, 1, 2, 1, 0, 2, 0, 2, 2, 3, 2, 3, 0, 4, 0, 4, 2, 5, 2, 5, 0, 6, 0, 6, 2, 7, 2, 7, 8, 4.5, 8, 4.5, 5.7, 2.5, 5.7, 2.5, 8, 0, 8], 1470, 81, 40, 19, 8, white);
  const moat: number[] = [];
  for (let step = 0; step <= 28; step++) { const angle = (0.08 + step / 28 * 0.84) * Math.PI; moat.push(1610 + Math.cos(angle) * 212, 211 + Math.sin(angle) * 62); }
  path(moat, 0, 0, 1, 1, 10, teal);
  type(RUNTIME_LIVERY_COPY[3], 1690, 321, 14, muted, 0.11);
  return { width, height, data };
}
