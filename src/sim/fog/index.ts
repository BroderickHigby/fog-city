import type { SimState } from "../contract.ts";
import type { World } from "../world.ts";

/** Wave 2's weather interface. The district/weather implementation arrives in wave 3. */
export function fogDensity(_world: World, _state: Readonly<SimState>, _x: number, _z: number): number {
  return 0;
}
