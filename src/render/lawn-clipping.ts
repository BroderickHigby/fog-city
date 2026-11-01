// Polygon booleans on a fixed 0.1 mm grid. Floating sweep-line comparisons can fail
// when independently projected lawn, road and building edges nearly coincide.
// This is finer than the source's centimetre coordinates and preserves shared seams.
import ClipperLib from "clipper-lib";

export type LawnPoint = [number, number];
export type LawnPolygon = LawnPoint[][];
export type LawnMultiPolygon = LawnPolygon[];
const SCALE = 10000;

function paths(polygons: readonly LawnPolygon[]): ClipperLib.Paths {
  return polygons.flatMap(polygon => polygon.flatMap((ring, index) => {
    const path: ClipperLib.Path = [];
    for (const [x, z] of ring) {
      const point = { X: Math.round(x * SCALE), Y: Math.round(z * SCALE) };
      const previous = path.at(-1);
      if (!previous || point.X !== previous.X || point.Y !== previous.Y) path.push(point);
    }
    const first = path[0], last = path.at(-1);
    if (first && last && first.X === last.X && first.Y === last.Y) path.pop();
    if (path.length < 3 || Math.abs(ClipperLib.Clipper.Area(path)) < 1) return [];
    // Nonzero fill unions overlapping outer rings, while each polygon's holes subtract.
    if (ClipperLib.Clipper.Orientation(path) !== (index === 0)) path.reverse();
    return [path];
  }));
}

function operation(type: ClipperLib.ClipType, subject: LawnMultiPolygon, clip: LawnMultiPolygon = []): LawnMultiPolygon {
  const subjects = paths(subject);
  if (!subjects.length) return [];
  const clips = paths(clip);
  if (type === ClipperLib.ClipType.ctIntersection && !clips.length) return [];
  const engine = new ClipperLib.Clipper(ClipperLib.InitOptions.ioStrictlySimple);
  engine.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true);
  if (clips.length) engine.AddPaths(clips, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  if (!engine.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error("Mapped lawn polygon clipping failed");
  }
  const points = (path: ClipperLib.Path): LawnPoint[] => path.map(p => [p.X / SCALE, p.Y / SCALE]);
  // PolyTree retains islands inside holes; a flat path list would lose that relation.
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map(polygon => [points(polygon.outer), ...polygon.holes.map(points)]);
}

export const unionLawns = (subject: LawnMultiPolygon): LawnMultiPolygon => operation(ClipperLib.ClipType.ctUnion, subject);
export const intersectLawns = (subject: LawnMultiPolygon, clip: LawnMultiPolygon): LawnMultiPolygon => operation(ClipperLib.ClipType.ctIntersection, subject, clip);
export const subtractLawns = (subject: LawnMultiPolygon, clip: LawnMultiPolygon): LawnMultiPolygon => operation(ClipperLib.ClipType.ctDifference, subject, clip);
