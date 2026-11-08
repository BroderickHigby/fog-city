// The Planner's side panel: choose the rush hour, the traffic level and the signal plan; read
// the scorecard. Plain DOM with native buttons and a table.
import type { Corridor } from "./corridor.ts";
import { CALTRANS_SOURCE, DOF_SOURCE, EPA_SOURCE, ARRB_SOURCE, SFMTA_SOURCE } from "./data.ts";
import type { Period } from "./demand.ts";
import { PEOPLE_PER_HOME, PLAN_NOTES, type DemandId, type PlanId } from "./scenarios.ts";
import type { Snapshot } from "./traffic.ts";
import type { CameraId } from "./view.ts";

export interface PanelState { period: Period; demand: DemandId; plan: PlanId; speed: number; camera: CameraId }
export interface ScoreRow { plan: PlanId; travelTimeS: [number, number]; stopsPerCar: number; lostHours: number; crossHours: number; co2KgPerHour: number; toBridgePerHour: number }

const PLAN_LABEL: Record<PlanId, string> = { today: "Today (assumed)", greenwave: "Green wave", optimized: "Optimized timing", adaptive: "Adaptive signals" };
const DEMAND_LABEL: Record<DemandId, string> = { now: "Today: Caltrans 2023-24 count", trend2031: "2031 · 82,069 homes · traffic follows the trend", grow2031: "2031 · 82,069 homes · traffic grows with population" };
const CAMERA_LABEL: Record<CameraId, string> = { tour: "Tour", overview: "Overview", street: "Street", follow: "Ride along" };

const CSS = `
.fcp{position:fixed;z-index:20;top:12px;right:12px;bottom:12px;width:min(390px,calc(100vw - 24px));overflow:auto;box-sizing:border-box;padding:16px 16px 12px;border-radius:14px;
 background:rgba(14,18,24,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#eef3f6;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.fcp h1{margin:0;font-size:19px;line-height:1.25;font-weight:650}.fcp .kick{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9fd8bd;font-weight:700}
.fcp .sub{color:#b4c2ca;margin:2px 0 10px}.fcp h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#93a3ad;margin:14px 0 6px;font-weight:700}
.fcp .seg{display:flex;gap:4px;flex-wrap:wrap}.fcp button{font:inherit;color:#e8eef2;background:#ffffff12;border:1px solid #ffffff1f;border-radius:8px;padding:6px 10px;cursor:pointer;min-height:32px}
.fcp button:hover{background:#ffffff22}.fcp button[aria-pressed=true]{background:#2f6f55;border-color:#79d3aa;color:#fff}
.fcp .plans{display:grid;grid-template-columns:1fr 1fr;gap:6px}.fcp .plans button{text-align:left;padding:8px 10px}
.fcp select{width:100%;font:inherit;color:#e8eef2;background:#1b232c;border:1px solid #ffffff26;border-radius:8px;padding:7px 8px}
.fcp .note{color:#b4c2ca;font-size:12px;margin-top:6px}.fcp .live{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}
.fcp .live div{background:#ffffff0d;border-radius:8px;padding:6px 8px}.fcp .live b{display:block;font-size:17px;font-variant-numeric:tabular-nums}.fcp .live span{font-size:11px;color:#a5b3bb}
.fcp table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px}.fcp th,.fcp td{padding:5px 4px;text-align:right;border-bottom:1px solid #ffffff14}
.fcp th:first-child,.fcp td:first-child{text-align:left}.fcp th{color:#93a3ad;font-weight:600;font-size:11px}.fcp tr.on td{background:#2f6f5540;color:#fff}
.fcp .good{color:#8ee6b6}.fcp .bad{color:#ffb38a}.fcp .bar{height:4px;border-radius:2px;background:#79d3aa;margin-top:3px}
.fcp .legend{display:flex;align-items:center;gap:8px;font-size:11px;color:#b4c2ca;margin-top:6px}.fcp .grad{flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg,#f2301f,#f2b81f,#5fd440)}
.fcp details{margin-top:12px;color:#a5b3bb;font-size:11px}.fcp details li{margin:3px 0;overflow-wrap:anywhere}.fcp .caveat{margin-top:10px;font-size:11px;color:#c9b88f}
@media (max-width:700px){.fcp{top:auto;left:8px;right:8px;width:auto;max-height:46vh;bottom:8px}}
`;

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

export interface PlannerPanel {
  update(state: PanelState, snap: Snapshot): void;
  setScores(rows: readonly ScoreRow[] | null): void;
  apply(change: Partial<PanelState>): void;
  element: HTMLElement;
}

export function mountPlannerPanel(doc: Document, parent: HTMLElement, opts: { corridor: Corridor; state: PanelState; onChange: (c: Partial<PanelState>) => void }): PlannerPanel {
  const root = doc.createElement("aside");
  root.className = "fcp"; root.setAttribute("aria-label", "Fog City Planner controls");
  const style = doc.createElement("style"); style.textContent = CSS;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => { const e = doc.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const c = opts.corridor;
  root.append(style, el("div", "Fog City Planner", "kick"), el("h1", "US-101 on Lombard Street"),
    el("p", `${c.signals[0]!.street} to Richardson Ave · ${(c.length / 1000).toFixed(1)} km · ${c.signals.length} signals · ${c.lanesPerDirection} lanes each way`, "sub"));

  const buttons = new Map<string, HTMLButtonElement>();
  const group = (title: string, cls: string, items: readonly [string, string, Partial<PanelState>][]): HTMLElement => {
    const box = el("div", "", cls); box.setAttribute("role", "group"); box.setAttribute("aria-label", title);
    for (const [key, label, change] of items) {
      const b = el("button", label); b.type = "button"; b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => opts.onChange(change));
      buttons.set(key, b); box.append(b);
    }
    return box;
  };
  root.append(el("h2", "Rush hour"), group("Rush hour", "seg", [["period:pm", "Evening · to the bridge", { period: "pm" }], ["period:am", "Morning · into town", { period: "am" }]]));
  root.append(el("h2", "Traffic"));
  const select = el("select"); select.setAttribute("aria-label", "Traffic level");
  for (const id of ["now", "trend2031", "grow2031"] as DemandId[]) { const o = el("option", DEMAND_LABEL[id]); o.value = id; select.append(o); }
  select.addEventListener("change", () => opts.onChange({ demand: select.value as DemandId }));
  const demandNote = el("p", "", "note");
  root.append(select, demandNote);
  root.append(el("h2", "Signals"), group("Signal plan", "plans", (["today", "greenwave", "optimized", "adaptive"] as PlanId[]).map((id) => [`plan:${id}`, PLAN_LABEL[id], { plan: id }])));
  const planNote = el("p", "", "note");
  root.append(planNote);
  const live = el("div", "", "live");
  const liveCars = el("b"), liveQueue = el("b"), liveRed = el("b");
  for (const [b, label] of [[liveCars, "cars on Lombard"], [liveQueue, "waiting to get on"], [liveRed, "lights red now"]] as const) { const d = el("div"); d.append(b, el("span", label)); live.append(d); }
  root.append(live);
  const legend = el("div", "", "legend"); legend.append(el("span", "stopped"), el("span", "", "grad"), el("span", "flowing"));
  root.append(legend);

  root.append(el("h2", "Scorecard · busiest hour, averaged over two runs"));
  const table = el("table");
  const cap = el("caption", ""); cap.style.cssText = "caption-side:bottom;text-align:left;color:#93a3ad;font-size:11px;padding-top:6px";
  const thead = el("thead"), hr = el("tr");
  for (const h of ["Signals", "Drive", "Stops", "Hours lost", "CO2 kg/h"]) hr.append(el("th", h));
  thead.append(hr);
  const tbody = el("tbody");
  table.append(cap, thead, tbody);
  root.append(table);

  root.append(el("h2", "Camera"), group("Camera", "seg", (["tour", "overview", "street", "follow"] as CameraId[]).map((id) => [`camera:${id}`, CAMERA_LABEL[id], { camera: id }])));
  root.append(el("h2", "Speed"), group("Playback speed", "seg", [1, 4, 10].map((s) => [`speed:${s}`, `${s}x`, { speed: s }])));
  root.append(el("p", "A model, not a traffic study. Traffic volumes are measured; SFMTA does not publish signal timing, so \"Today\" is an assumption. Compare the plans with each other.", "caveat"));
  const details = el("details"); details.append(el("summary", "Sources"));
  const list = el("ul");
  for (const s of [CALTRANS_SOURCE, SFMTA_SOURCE, DOF_SOURCE, ARRB_SOURCE, EPA_SOURCE, "Streets and signals: DataSF 3psu-pn9h and ybh5-27n2 (PDDL 1.0)."]) list.append(el("li", s));
  details.append(list);
  root.append(details);
  parent.append(root);

  let rows: readonly ScoreRow[] | null = null, current = opts.state;
  const renderScores = (): void => {
    tbody.replaceChildren();
    if (!rows) { const tr = el("tr"), td = el("td", "Running the model…"); td.colSpan = 5; tr.append(td); tbody.append(tr); return; }
    const base = rows.find((r) => r.plan === "today")!;
    const maxCo2 = Math.max(...rows.map((r) => r.co2KgPerHour));
    const busy = current.period === "pm" ? 0 : 1;
    for (const r of rows) {
      const tr = el("tr"); if (r.plan === current.plan) tr.className = "on";
      const name = el("td"); name.append(el("span", PLAN_LABEL[r.plan]));
      const bar = el("div", "", "bar"); bar.style.width = `${(r.co2KgPerHour / maxCo2) * 100}%`; name.append(bar);
      const dCo2 = (r.co2KgPerHour / base.co2KgPerHour - 1) * 100;
      const co2 = el("td"); co2.append(el("span", fmt(r.co2KgPerHour)), doc.createElement("br"),
        el("span", r.plan === "today" ? "baseline" : `${dCo2 <= 0 ? "" : "+"}${dCo2.toFixed(0)}%`, dCo2 <= -0.5 ? "good" : dCo2 >= 0.5 ? "bad" : ""));
      tr.append(name, el("td", mmss(r.travelTimeS[busy])), el("td", r.stopsPerCar.toFixed(1)), el("td", fmt(r.lostHours)), co2);
      tbody.append(tr);
    }
    cap.textContent = `Drive: Van Ness to Richardson in the busy direction (${busy === 0 ? "westbound" : "eastbound"}). Hours lost: everyone's waiting per hour, side streets included.`;
  };
  renderScores();

  const panel: PlannerPanel = {
    element: root,
    update(state, snap) {
      current = state;
      for (const [key, b] of buttons) {
        const [k, v] = key.split(":");
        b.setAttribute("aria-pressed", String(String(state[k as keyof PanelState]) === v));
      }
      if (select.value !== state.demand) select.value = state.demand;
      demandNote.textContent = state.demand === "now" ? "Peak hours from Caltrans' 2023-24 counts on this stretch: 2,800 vehicles at Van Ness, 3,450 at Broderick."
        : state.demand === "trend2031" ? `San Francisco grew 18% from 1996 to 2019 while Lombard's traffic stayed level. Built out at ${PEOPLE_PER_HOME} people a home, the trend says the peak hour barely changes.`
        : `If traffic grew in step with population instead (${PEOPLE_PER_HOME} people a home): a stress test, not a forecast.`;
      planNote.textContent = PLAN_NOTES[state.plan];
      liveCars.textContent = fmt(snap.cars.length);
      liveQueue.textContent = fmt(snap.entryQueue[0] + snap.entryQueue[1]);
      liveRed.textContent = `${snap.main.filter((a) => a !== "green").length}/${snap.main.length}`;
      renderScores();
    },
    setScores(r) { rows = r; renderScores(); },
    apply(change) { opts.onChange(change); },
  };
  return panel;
}
