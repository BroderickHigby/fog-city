/** Immutable street rules published by the world pipeline. Never stored in SimState. */
export interface ParkingRule {
  id: string;
  edge: string;
  side: "L" | "R";
  kind: string;
  /** ISO weekdays, Monday=1 through Sunday=7. */
  days: number[];
  /** Minutes after midnight. */
  from: number;
  to: number;
  hourLimit: number;
  permitAreas: string[];
  lengthM: number;
}
export interface ParkingLayer {
  version: number;
  world: string;
  rules: ParkingRule[];
}
export interface StreetCleaningRule {
  edge: string;
  side: "L" | "R";
  /** ISO weekday; zero means holidays only. */
  day: number;
  fromHour: number;
  toHour: number;
  weeks: number[];
  holidays: boolean;
}
export interface StreetCleaningLayer {
  version: number;
  world: string;
  rules: StreetCleaningRule[];
}
