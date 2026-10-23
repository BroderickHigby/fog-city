import type { SimSystem } from "../system-contract.ts";
import { robotRuntimeSystem } from "./runtime-system.ts";

export const systems: readonly SimSystem[] = Object.freeze([robotRuntimeSystem]);
