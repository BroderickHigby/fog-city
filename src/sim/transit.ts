/** Immutable local-metre transit geometry loaded with a world, never stored per tick. */
export interface FleetTransitRoute {
  readonly id: string;
  readonly line: string;
  readonly mode: "bus" | "rail" | "streetcar" | "cable";
  readonly direction: "inbound" | "outbound";
  readonly night: boolean;
  readonly lengthM: number;
  readonly paths: readonly (readonly (readonly [number, number])[])[];
}
export interface FleetTransitStop {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly routes: readonly string[];
  readonly on?: string;
  readonly at?: string;
}
export interface FleetTransitLayer {
  readonly version: 1;
  readonly world: string;
  readonly routes: readonly FleetTransitRoute[];
  readonly stops: readonly FleetTransitStop[];
  readonly description?: string;
  readonly attribution?: string;
}
const validated = new WeakSet<object>();
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Strict boundary validation for the published transit layer. Missing named files
 * are the loader's error; an absent optional layer remains a separate fallback case.
 */
export function parseFleetTransitLayer(input: unknown): FleetTransitLayer {
  const value = record(input);
  if (!value || value.version !== 1 || !id(value.world) || !Array.isArray(value.routes) || value.routes.length > 512 ||
      !Array.isArray(value.stops) || value.stops.length > 8192 ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.attribution !== undefined && typeof value.attribution !== "string")) throw new RangeError("Invalid fleet transit layer");
  if (validated.has(value)) return value as unknown as FleetTransitLayer;
  const routes = new Set<string>(), stops = new Set<string>();
  let points = 0;
  const ownedRoutes: FleetTransitRoute[] = [], ownedStops: FleetTransitStop[] = [];
  for (const raw of value.routes) {
    const route = record(raw);
    if (!route || !id(route.id) || routes.has(route.id) || typeof route.line !== "string" || route.line.length > 128 ||
        !["bus", "rail", "streetcar", "cable"].includes(String(route.mode)) || !["inbound", "outbound"].includes(String(route.direction)) ||
        typeof route.night !== "boolean" || !coordinate(route.lengthM) || route.lengthM < 0 ||
        !Array.isArray(route.paths) || route.paths.length < 1 || route.paths.length > 64) throw new RangeError("Invalid fleet transit route");
    routes.add(route.id);
    for (const path of route.paths) {
      if (!Array.isArray(path) || path.length < 2 || path.length > 4096) throw new RangeError("Invalid fleet transit path");
      points += path.length;
      if (points > 100000) throw new RangeError("Fleet transit point capacity exceeded");
      for (const point of path) if (!Array.isArray(point) || point.length !== 2 || !coordinate(point[0]) || !coordinate(point[1])) throw new RangeError("Invalid fleet transit point");
    }
    ownedRoutes.push(Object.freeze({ id: route.id, line: route.line, mode: route.mode as FleetTransitRoute["mode"],
      direction: route.direction as FleetTransitRoute["direction"], night: route.night, lengthM: route.lengthM,
      paths: Object.freeze(route.paths.map(path => Object.freeze((path as [number, number][]).map(point => Object.freeze([point[0], point[1]] as const))))) }));
  }
  for (const raw of value.stops) {
    const stop = record(raw);
    if (!stop || !id(stop.id) || stops.has(stop.id) || !coordinate(stop.x) || !coordinate(stop.y) || !coordinate(stop.z) ||
        !Array.isArray(stop.routes) || stop.routes.length > 256 || !stop.routes.every(id) ||
        (stop.on !== undefined && typeof stop.on !== "string") || (stop.at !== undefined && typeof stop.at !== "string")) throw new RangeError("Invalid fleet transit stop");
    stops.add(stop.id);
    ownedStops.push(Object.freeze({ id: stop.id, x: stop.x, y: stop.y, z: stop.z, routes: Object.freeze([...(stop.routes as string[])]),
      ...(typeof stop.on === "string" ? { on: stop.on } : {}), ...(typeof stop.at === "string" ? { at: stop.at } : {}) }));
  }
  const owned: FleetTransitLayer = Object.freeze({ version: 1, world: value.world, routes: Object.freeze(ownedRoutes), stops: Object.freeze(ownedStops),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.attribution === "string" ? { attribution: value.attribution } : {}) });
  validated.add(owned);
  return owned;
}
