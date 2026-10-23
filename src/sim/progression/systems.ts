import type { SimSystem } from "../system-contract.ts";

/** Reserved registration point; the owning lane replaces this list when ready. */
export const systems: readonly SimSystem[] = Object.freeze([]);
