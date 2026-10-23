import type { Position } from "./gameplay-contract.ts";
import { buildSidewalkGraph, type SidewalkGraph } from "./agents/navigation.ts";

export interface WorldSidewalkData {
  nodes: { id: string; x: number; y?: number; z: number }[];
  edges: { id: string; a: string; b: string; kind: "sidewalk" | "crossing"; road?: string; points?: [number, number][] }[];
}

export function buildWorldNavigation(data: WorldSidewalkData): SidewalkGraph {
  const nodes = new Map(data.nodes.map(node => [node.id,node]));
  return buildSidewalkGraph({ nodes:data.nodes, edges:data.edges.map(edge=>{
    const a=nodes.get(edge.a), b=nodes.get(edge.b);
    if(!a || !b) throw new Error(`Unknown sidewalk endpoint: ${edge.id}`);
    return {id:edge.id,a:edge.a,b:edge.b,kind:edge.kind==="crossing"?"crosswalk":"sidewalk",roadId:edge.road,
      points:edge.points??[[a.x,a.z],[b.x,b.z]],bidirectional:true};
  }) });
}

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
