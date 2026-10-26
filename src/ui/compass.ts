const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const FULL_TURN = Math.PI * 2;

export interface CompassHeading {
  /** Whole degrees clockwise from north, in the range 0–359. */
  bearing: number;
  direction: typeof DIRECTIONS[number];
  label: string;
  /** Unrounded degrees in the range 0–360 for a smoothly rotating needle. */
  rotation: number;
}

/** Present a compass heading: zero faces north and positive radians turn east. */
export function formatCompass(headingRadians: number): CompassHeading {
  // Reduce radians before converting so even very large finite inputs cannot overflow.
  const degrees = Number.isFinite(headingRadians) ? (headingRadians % FULL_TURN) * 180 / Math.PI : 0;
  const rotation = (degrees + 360) % 360;
  const bearing = Math.round(rotation) % 360;
  const direction = DIRECTIONS[Math.floor((rotation + 22.5) / 45) % DIRECTIONS.length]!;
  return { bearing, direction, label: `${direction} · ${String(bearing).padStart(3, "0")}°`, rotation };
}
