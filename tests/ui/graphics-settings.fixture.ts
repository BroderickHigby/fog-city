import { GfxPreferenceController, type GfxApplied } from "../../src/render/gfx-preference.ts";
import { mountGraphicsSettings } from "../../src/ui/graphics-settings.ts";
import { mountGameUI } from "../../src/ui/mount.ts";
import { uiText } from "../../src/content/ui.ts";
import type { UiView } from "../../src/ui/types.ts";

let mode = new URL(location.href).searchParams.get("apply") ?? "immediate";
let finish: ((value: GfxApplied) => void) | undefined;
const requests: string[] = [];
const controller = new GfxPreferenceController({ url: new URL(location.href), caps: { webgl2: true, renderer: "Intel Iris", maxTextureSize: 16384, mobile: false },
  apply: ({ requested }) => {
    requests.push(requested);
    if (mode === "fail") throw new Error("fixture device loss");
    const applied: GfxApplied = { tier: requested === "auto" ? "standard" : requested, reason: "interaction fixture only" };
    return mode === "delayed" ? new Promise(resolve => { finish = resolve; }) : applied;
  } });
const view: UiView = { tick: 10, playerId: "p1", x: 0, z: 0, heading: 0, speedMps: 0, runwayMonths: 18, cashCents: 200000, reputation: 50, waterLitres: 8, capacityLitres: 8, salt: false, threat: 0, phoneApps: ["settings", "map", "bank"] };
const ui = mountGameUI(document.querySelector<HTMLElement>("#game")!, { copy: uiText, graphicsSettings: doc => mountGraphicsSettings(doc, { controller }) });
ui.update(view);
Object.assign(window, { ui, controller, requests, setApplyMode: (value: string) => { mode = value; }, finishGraphics: () => { finish?.({ tier: "low", reason: "interaction fixture completed" }); } });
