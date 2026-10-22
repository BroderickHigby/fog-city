// The house-kit look-dev street (lookdev/10_house_kit.py): a row of San Francisco houses laid out
// with the real layout maths (runtime/house-kit.ts) and the contract (house-kit.json), printed
// as JSON for the Blender script. Every instance matrix is in its house's facade frame.
//
//   node assets/blender/tools/house-kit-demo.ts > /tmp/demo.json

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bayLayout, rooflineLayout, roofLayout, stairLayout, stoopLayout, type Instance, type KitDoc } from "../runtime/house-kit.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const kit = JSON.parse(readFileSync(join(REPO, "public/models/house-kit/house-kit.json"), "utf8")) as KitDoc;

interface House {
  name: string;
  /** Centre of the front wall along the street (Blender X), metres. */
  x: number;
  frontM: number;
  depthM: number;
  roofM: number;
  floorM: number;
  storeys: number;
  storeyM: number;
  body: string;
  trim: string;
  instances: Instance[];
}

function house(name: string, x: number, o: { front: number; depth?: number; roof: number; floor: number; storeys: number; storeyM: number; bay?: string; roofline: string; door: number; rails?: boolean; body: string; trim: string; props?: boolean; year?: number }): House {
  const inst: Instance[] = [];
  const drop = kit.prototypes[o.roofline]!.dropM as number;
  if (o.bay) inst.push(...bayLayout(kit, { proto: o.bay, frontM: o.front, storeys: o.storeys, storeyM: o.storeyM, roofM: o.roof, floorM: o.floor, rooflineDropM: drop }));
  inst.push(...stoopLayout(kit, { riseM: o.floor, x: o.door, rails: o.rails }).instances);
  inst.push(...rooflineLayout(kit, o.roofline, o.front, o.roof));
  const depth = o.depth ?? 18;
  if (o.props) {
    const fp: Array<[number, number]> = [[-o.front / 2, 0], [o.front / 2, 0], [o.front / 2, depth], [-o.front / 2, depth]];
    inst.push(...roofLayout({ footprint: fp, roofM: o.roof, storeys: o.storeys, year: o.year, hash: 0.21 }));
  }
  return { name, x, frontM: o.front, depthM: depth, roofM: o.roof, floorM: o.floor, storeys: o.storeys, storeyM: o.storeyM, body: o.body, trim: o.trim, instances: inst };
}

const houses: House[] = [
  house("italianate", -19.5, { front: 7.5, roof: 10.2, floor: 1.6, storeys: 2, storeyM: 3.4, bay: "bay-italianate", roofline: "cornice-italianate", door: 2.3, rails: true, body: "#2f6f6a", trim: "#efe6cf" }),
  house("queen-anne", -12.0, { front: 7.5, roof: 10.8, floor: 1.7, storeys: 2, storeyM: 3.3, bay: "bay-queen-anne", roofline: "cornice-edwardian", door: -2.3, rails: true, body: "#c9657a", trim: "#f4efe3" }),
  house("edwardian", -4.5, { front: 7.5, roof: 11.1, floor: 1.0, storeys: 3, storeyM: 3.1, bay: "bay-edwardian", roofline: "parapet-coping", door: 2.4, body: "#e3c56a", trim: "#fbf7ea" }),
  house("corner-turret", 3.0, { front: 7.5, roof: 9.4, floor: 1.6, storeys: 2, storeyM: 3.3, bay: "bay-turret", roofline: "cornice-italianate", door: -2.2, rails: true, body: "#8f7fb0", trim: "#efe9f7" }),
  house("apartments-1925", 17.0, { front: 15.0, depth: 22, roof: 16.6, floor: 0.5, storeys: 5, storeyM: 3.2, roofline: "parapet-coping", door: 0.0, body: "#cdb89a", trim: "#efe7d6", props: true, year: 1925 }),
];

// A public stairway climbing beside the row (path frame), and the same climb as a textured ramp.
const profile: Array<[number, number]> = [[0, 0], [3, 0.1], [11, 4.1], [13, 4.15], [21, 8.1], [24, 8.2]];
const stairs = { profile, widthM: 2.2, instances: stairLayout(kit, profile, 2.2, true).instances };

process.stdout.write(JSON.stringify({ storeyM: kit.storeyM, slots: kit.slots, houses, stairs }, null, 1));
