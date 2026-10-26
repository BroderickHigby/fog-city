// Five independently authored CC0 bodies; measured import metadata, not paint variants.
import records from "./vehicle-models.json" with { type: "json" };
export type VehicleFamilyId = "compact-hatch" | "sedan" | "utility-suv" | "short-pickup" | "cargo-van";
export interface VehicleModel {
  id: VehicleFamilyId; url: string; sha256: string; bytes: number; triangles: number;
  lengthM: number; bodyWidthM: number; totalWidthM: number; heightM: number;
  wheelbaseM: number; wheelRadiusM: number; wheelWidthM: number; trackM: number;
  paintMaterial: string; audioProfile: "light-ice" | "utility-ice";
  far: {method: string;cellM: number}; visualApproved: boolean;
}
export const VEHICLE_MODELS: readonly VehicleModel[] = Object.freeze(records.map(record => ({...record,id:record.id as VehicleFamilyId,audioProfile:record.audioProfile as VehicleModel["audioProfile"]})));
export const VEHICLE_MODEL_FILES: Readonly<Record<string,string>> = Object.freeze(Object.fromEntries(VEHICLE_MODELS.map(f=>[`civilian:${f.id}`,f.url])));
/** Shared by the renderer and occupied civilian audio. Stable integer identity; no sim mutation. */
export function vehicleModelForActor(id: number): VehicleModel {
  return VEHICLE_MODELS[(Math.imul(Math.trunc(id),2654435761) >>> 0) % VEHICLE_MODELS.length]!;
}
