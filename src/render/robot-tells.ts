import type * as THREE from "three";
import type { SimState } from "../sim/contract.ts";
import type { RobotTellPresentation } from "../sim/robots/catalog.ts";
import { robotMetadata } from "../sim/robots/metadata.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function presentation(value: unknown): RobotTellPresentation | null {
  const source = record(value); if (!source) return null;
  const finite = (key: string, fallback: number) => typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] as number : fallback;
  return { bagFull: typeof source.bagFull === "boolean" ? source.bagFull : null,
    bagSwing: Math.max(1, Math.min(2.5, finite("bagSwing", 1))),
    headYaw: typeof source.headYaw === "number" && Number.isFinite(source.headYaw) ? Math.max(-1.1, Math.min(1.1, source.headYaw)) : null,
    faceLight: Math.max(0, Math.min(1, finite("faceLight", 1))) };
}

/** Read presentation only, never firmware: ordinary good and bad bots keep the same authored models. */
export function robotTellFrame(previous: Readonly<SimState>, current: Readonly<SimState>, alpha: number): ReadonlyMap<number, RobotTellPresentation> {
  const metadata = record(current.ext.robots), result = new Map<number, RobotTellPresentation>();
  if (metadata?.enabled !== true) return result;
  const before = new Map<number, RobotTellPresentation>();
  for (const value of robotMetadata(previous).slice(0, 4096)) {
    const item = record(value), parsed = presentation(item?.presentation);
    if (item && Number.isSafeInteger(item.agentId) && parsed) before.set(item.agentId as number, parsed);
  }
  const ids = new Set((current.ext.agents?.list ?? []).filter(agent => agent.kind !== "person").map(agent => agent.id));
  const targets = record(record(current.ext.combat)?.targets), blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  for (const value of robotMetadata(current).slice(0, 4096)) {
    const item = record(value); if (!item || !Number.isSafeInteger(item.agentId) || item.present === false || !ids.has(item.agentId as number)) continue;
    const phase = record(targets?.[`agent:${item.agentId}`])?.phase ?? item.phase;
    if (phase !== undefined && phase !== null && phase !== "active") continue;
    const parsed = presentation(item.presentation); if (!parsed) continue;
    const old = before.get(item.agentId as number);
    result.set(item.agentId as number, { ...parsed, headYaw: old?.headYaw !== null && old?.headYaw !== undefined && parsed.headYaw !== null ?
      old.headYaw + (parsed.headYaw - old.headYaw) * blend : parsed.headYaw });
  }
  return result;
}

/** Fade the existing status-light channel only; brake/head lights and body colors are untouched. */
export function installRobotStatusLights(material: THREE.Material): void {
  const original = material.onBeforeCompile.bind(material), originalKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    original(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float fcStatusLight;")
      .replace("vFcEmit = fcEmit.rgb * k;", "vFcEmit = fcEmit.rgb * k * (ch > 2.5 ? fcStatusLight : 1.0);\nif (ch > 2.5) vColor.rgb *= fcStatusLight;");
  };
  material.customProgramCacheKey = () => `${originalKey()}:robot-status-light:v1`;
}
