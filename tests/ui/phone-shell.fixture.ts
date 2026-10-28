import { AudioPrefsStore } from "../../src/audio/prefs.ts";
import { GfxPreferenceController } from "../../src/render/gfx-preference.ts";
import { SaveStore, MemorySaveBackend } from "../../src/save/index.ts";
import { mountAudioSettings } from "../../src/ui/audio-settings.ts";
import { mountGraphicsSettings } from "../../src/ui/graphics-settings.ts";
import { mountGameUI } from "../../src/ui/mount.ts";
import { uiText } from "../../src/content/ui.ts";
import type { MapPoint, UiView } from "../../src/ui/types.ts";

const audio = new AudioPrefsStore(null);
const graphics = new GfxPreferenceController({ url: new URL(location.href), storage: null,
  caps: { webgl2: true, renderer: "Intel Iris", maxTextureSize: 16384, mobile: false },
  apply: ({ requested }) => ({ tier: requested === "auto" ? "standard" : requested, reason: "phone interaction fixture" }) });
const store = new SaveStore({ backends: [new MemorySaveBackend()], contentHash: "phone-fixture", validate: data => data });
let view: UiView = { tick: 17, playerId: "p1", x: 0, z: 0, heading: 0, speedMps: 0, runwayMonths: 18, cashCents: 32150, reputation: 50, waterLitres: 8, capacityLitres: 8, salt: false, threat: 0,
  streetName: "Embarcadero", phoneApps: ["map", "botBounty", "botCheck", "bank", "settings", "officeHours", "ride", "radio", "messages", "fogcast", "playlists"],
  officeHours: { available: false, detail: "Visit the Ramen door to book your interview.", remaining: 2, destination: { x: 120, z: 200 } },
  map: { nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }], edges: [{ from: "a", to: "b" }], blips: [{ id: "water", kind: "water", x: 20, z: 20, label: "Water" }] },
  bounties: [{ id: "b1", title: "Confirmed rogue firmware", detail: "At the waterfront", multiplier: 2, confirmed: true }], scan: { targetId: "b1", bad: true, confidence: .93 } };
const waypoints: MapPoint[] = [], appEvents: string[] = [], bookingRequests: number[] = [];
const ui = mountGameUI(document.querySelector<HTMLElement>("#game")!, { copy: uiText, touch: new URLSearchParams(location.search).get("touch") === "1",
  callbacks: { waypoint: point => waypoints.push(point), app: app => appEvents.push(app), bookOfficeHours: () => bookingRequests.push(view.tick) },
  graphicsSettings: doc => mountGraphicsSettings(doc, { controller: graphics }), audioSettings: doc => mountAudioSettings(doc, { store: audio }),
  saves: { store, capture: () => ({ wallet: { cashCents: view.cashCents } }), restore: () => {} } });
ui.update(view);
Object.assign(window, { ui, waypoints, appEvents, bookingRequests, updatePhoneFixture: (patch: Partial<UiView>) => { view = { ...view, ...patch }; ui.update(view); } });
