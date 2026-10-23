// Provided by the fogcity-assets plugin in vite.config.ts.
declare module "virtual:fogcity-assets" {
  /** Paths under public/, e.g. "models/player-car.glb". */
  export const models: string[];
  /** content/landmarks.json, parsed; null when the file is absent or unreadable. */
  export const landmarks: unknown;
  /** public/models/house-kit/house-kit.json, parsed; null when absent or unreadable. */
  export const houseKit: unknown;
}
