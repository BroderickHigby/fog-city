// Saved metadata stores observations; this view derives descriptions from their owners.
import type { SimState } from "../contract.ts";
import type { TargetCombat } from "../combat/types.ts";
import { robotCatalogPresentation, robotCatalogProfile, robotCatalogProfileForSource, type RobotCatalogSource } from "./catalog.ts";
import { ambientProfilesOf } from "../agents/ambient-runtime.ts";
import type { RobotCatalogMetadata } from "./catalog.ts";
import type { RobotLocomotion, RobotRecruitOffer, RobotRepairTravel, RobotRuntimeEntry, RobotRuntimeState } from "./runtime.ts";

export interface RobotRuntimeMetadata extends Partial<RobotCatalogMetadata> {
  readonly pendingGoalIds?: readonly string[];
  readonly agentId: number;
  readonly actorId: string;
  readonly present: boolean;
  readonly firmware: "good" | "bad";
  readonly baselineFirmware: "good" | "bad";
  readonly mode: NonNullable<RobotRuntimeEntry["brain"]>["mode"] | null;
  readonly phase: TargetCombat["phase"] | null;
  readonly rust: number | null;
  readonly convertedTick: number | null;
  readonly bountyUntilTick: number;
  readonly recruitOffer: RobotRecruitOffer | null;
  readonly repairTravel: RobotRepairTravel | null;
  readonly significant: RobotRuntimeEntry["significant"];
  readonly deferredSignificance?: RobotRuntimeEntry["deferredSignificance"];
}

export type StoredRobotMetadata = Pick<RobotRuntimeMetadata, "agentId"> & Partial<Omit<RobotRuntimeMetadata, "agentId">>;
interface MetadataSource {
  readonly metadataVersion?: unknown;
  readonly metadata?: unknown;
  readonly brain?: unknown;
  readonly actors?: unknown;
  readonly baselines?: unknown;
  readonly locomotion?: unknown;
  readonly catalogLevel?: unknown;
  readonly catalogArchetypes?: unknown;
  readonly catalogSources?: unknown;
}
type StaticCatalog = Pick<RobotCatalogMetadata, "catalogArchetypeId" | "tellIds" | "pendingTellIds" | "hiddenTellId">;
const staticCatalogs = new Map<string, StaticCatalog | null>();
const MAX_CACHED_CATALOGS = 4096;
const metadataViews = new WeakMap<object, { readonly seed: number; readonly ambient: unknown; readonly result: readonly RobotRuntimeMetadata[] }>();
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const rows = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

function staticCatalog(seed: number, entry: RobotRuntimeEntry, row: StoredRobotMetadata, source: MetadataSource): StaticCatalog | null {
  if (!row.presentation) return null;
  const level = typeof source.catalogLevel === "number" ? source.catalogLevel : 1;
  const overrides = record(source.catalogArchetypes), choices = record(overrides?.[String(entry.agentId)]);
  const override = choices?.[entry.firmware];
  const archetype = typeof override === "string" ? override : undefined;
  const sourceRecord = record(record(source.catalogSources)?.[String(entry.agentId)]);
  const identity = sourceRecord ? { seed: sourceRecord.seed as number, key: sourceRecord.key as string } : null;
  const key = JSON.stringify([seed, entry.agentId, entry.model, entry.firmware, level, archetype, row.hideOneTell === true, identity]);
  if (staticCatalogs.has(key)) return staticCatalogs.get(key)!;
  const profile = identity ? robotCatalogProfileForSource(identity, entry.model ?? "", entry.firmware, level, archetype) :
    robotCatalogProfile(seed, entry.agentId, entry.model ?? "", entry.firmware, level, archetype);
  const presentation = profile ? robotCatalogPresentation(profile, { tick: 0, x: 0, z: 0, heading: 0,
    hideOneTell: row.hideOneTell === true, sabotageActive: false }) : null;
  const result = presentation ? { catalogArchetypeId: presentation.catalogArchetypeId, tellIds: presentation.tellIds,
    pendingTellIds: presentation.pendingTellIds, hiddenTellId: presentation.hiddenTellId } : null;
  if (staticCatalogs.size >= MAX_CACHED_CATALOGS) staticCatalogs.clear();
  staticCatalogs.set(key, result);
  return result;
}

function owners(source: MetadataSource) {
  const brain = source.brain as Partial<RobotRuntimeState> | undefined;
  const entries = new Map(rows(brain?.robots).map(value => { const entry = value as RobotRuntimeEntry; return [entry.agentId, entry] as const; }));
  const present = new Set(rows(source.actors).map(value => record(value)?.id));
  const baselines = new Map(rows(source.baselines).map(value => { const row = record(value); return [row?.agentId, row?.firmware] as const; }));
  const repairs = new Map(rows(source.locomotion).map(value => { const row = value as RobotLocomotion; return [row.agentId, row.repairTravel] as const; }));
  return { entries, present, baselines, repairs };
}

function derived(seed: number, source: MetadataSource, row: StoredRobotMetadata, by: ReturnType<typeof owners>): Partial<RobotRuntimeMetadata> | null {
  const entry = by.entries.get(row.agentId);
  if (!entry) return null;
  const baseline = by.baselines.get(entry.agentId), catalog = staticCatalog(seed, entry, row, source);
  return { agentId: entry.agentId, actorId: `agent:${entry.agentId}`, present: by.present.has(`agent:${entry.agentId}`),
    firmware: entry.firmware, baselineFirmware: baseline === "bad" ? "bad" : "good", mode: entry.brain?.mode ?? null,
    convertedTick: entry.convertedTick, bountyUntilTick: entry.bountyUntilTick, recruitOffer: entry.recruitOffer,
    repairTravel: by.repairs.get(entry.agentId) ?? null, significant: entry.significant,
    ...(entry.deferredSignificance?.length ? { deferredSignificance: entry.deferredSignificance } : {}),
    ...(catalog ? { ...catalog, hideOneTell: false, sabotageActive: false, pendingGoalIds: [] } : {}) };
}

/** Exact old full snapshots remain accepted; compact rows retain tick-local observations. */
export function robotMetadata(state: Readonly<SimState>): readonly RobotRuntimeMetadata[] {
  const source = record(state.ext.robots) as MetadataSource | null;
  if (!source || !Array.isArray(source.metadata)) return [];
  if (source.metadataVersion !== 1) return source.metadata as RobotRuntimeMetadata[];
  const ambient = record(record(state.ext.agents)?.runtime)?.ambient;
  const cached = metadataViews.get(source);
  if (cached?.seed === state.seed && cached.ambient === ambient) return cached.result;
  const catalogSources: Record<string, RobotCatalogSource> = {};
  for (const profile of ambientProfilesOf(state)) catalogSources[String(profile.id)] = { seed: profile.seed, key: profile.key };
  const described = { ...source, catalogSources }, by = owners(described);
  const result = source.metadata.map(value => {
    const row = value as StoredRobotMetadata, base = derived(state.seed, described, row, by);
    return base ? { ...base, ...row } as RobotRuntimeMetadata : row as RobotRuntimeMetadata;
  });
  metadataViews.set(source, { seed: state.seed, ambient, result });
  return result;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  const left = record(a), right = record(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Only omit a field when its exact value is recoverable; unknown/custom fields survive. */
export function storeRobotMetadata(seed: number, source: MetadataSource & { readonly metadata: readonly RobotRuntimeMetadata[] }): readonly StoredRobotMetadata[] {
  const by = owners(source);
  return source.metadata.map(row => {
    const base = derived(seed, source, row, by);
    if (!base) return row;
    const stored = { ...row } as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      if (key !== "agentId" && Object.hasOwn(stored, key) && sameValue(stored[key], (base as Record<string, unknown>)[key])) delete stored[key];
    }
    return stored as StoredRobotMetadata;
  });
}
