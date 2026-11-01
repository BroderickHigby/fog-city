// Optional render-only data, loaded before terrain starts streaming. Both the persistent
// terrain lawn surface and nearby blade detail use this same document.
import type { Assets } from "./assets.ts";

export async function loadLawnData(assets: Pick<Assets, "json">, base: string): Promise<unknown> {
  let index: { layers?: { grass?: string } } | null;
  try { index = await assets.json(base + "street-detail.json"); }
  catch { return null; }
  const file = index?.layers?.grass;
  if (!file) return null;
  try { return await assets.json(base + file); }
  catch (error) {
    console.warn(`[fog-city] lawns ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
