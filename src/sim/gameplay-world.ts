import type { Position } from "./gameplay-contract.ts";

export interface WorldRefill extends Position {
  id: string;
  kind: "hydrant" | "fountain" | "bay";
  radius: number;
  salt: boolean;
}
export interface WorldGameplayAnchor extends Position {
  id: string;
  kind: "car-wash" | "repair-kiosk" | "garage-candidate" | "activity-candidate";
  roadNodeId: string;
  districtId: string;
}
export interface WorldGameplayTile {
  id: string;
  sidewalkNodes: string[];
  sidewalkEdges: string[];
  refills: string[];
  anchors: string[];
  signals: string[];
  transitStops: string[];
  transitRoutes: string[];
}
export interface WorldGameplayTerritory {
  step: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9a" | "9b";
  wave: number;
  districtIds: string[];
  tileIds: string[];
}
/** Static, plain-JSON layer named by manifest.layers.gameplay. Never stored in SimState. */
export interface GameplayWorldData {
  version: 1;
  world: string;
  sourceSnapshot: string;
  refills: WorldRefill[];
  anchors: WorldGameplayAnchor[];
  tiles: WorldGameplayTile[];
  territories: WorldGameplayTerritory[];
}
