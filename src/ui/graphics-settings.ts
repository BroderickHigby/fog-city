import type { GfxRequest } from "../render/gfx.ts";
import type { GfxPreferenceController, GfxPreferenceState } from "../render/gfx-preference.ts";

export const GRAPHICS_CHOICES: readonly { value: GfxRequest; label: string; detail: string }[] = [
  { value: "auto", label: "Auto", detail: "Choose for this device and reduce detail if rendering slows." },
  { value: "low", label: "Low", detail: "Lower resolution, with shadows and post-processing off." },
  { value: "standard", label: "Standard", detail: "Shadows and effects, with a 1080p pixel budget." },
  { value: "high", label: "High", detail: "Sharper rendering with a larger pixel budget. Uses more GPU memory." },
];
const STYLES = `.fc-graphics-settings{margin-block:24px;min-width:0}.fc-graphics-settings h2{margin:0 0 6px;font-size:18px}.fc-graphics-settings p{margin:6px 0;font-size:14px;overflow-wrap:anywhere}.fc-graphics-settings fieldset{margin:12px 0;padding:0;border:0;min-width:0}.fc-graphics-settings legend{font-size:14px;font-weight:650;margin-bottom:4px}.fc-graphics-choice{display:grid;grid-template-columns:22px minmax(0,1fr);column-gap:10px;row-gap:2px;align-items:start;padding-block:10px;min-height:44px;border-bottom:1px solid #ffffff24;cursor:pointer}.fc-graphics-choice input{width:20px;height:20px;accent-color:#b7edca;margin:1px 0 0}.fc-graphics-choice strong{font-size:16px;line-height:22px}.fc-graphics-choice small{display:block;margin-top:3px;font-size:14px;line-height:1.45;color:#c4d5d7}.fc-graphics-choice:has(input:disabled){cursor:wait}.fc-graphics-choice input:disabled+span{opacity:.65}.fc-graphics-settings .fc-graphics-status{color:#d7eadd}.fc-graphics-settings .fc-graphics-error{color:#ffd4a2}.fc-graphics-settings button{margin-top:8px}`;
let nextPanel = 0;

/** Native radio controls retain keyboard, touch and assistive-technology behavior. */
export function mountGraphicsSettings(doc: Document, options: { controller: GfxPreferenceController }): { element: HTMLElement; dispose(): void } {
  const root = doc.createElement("section"), style = doc.createElement("style"), title = doc.createElement("h2");
  root.className = "fc-graphics-settings"; root.setAttribute("aria-label", "Graphics settings");
  style.textContent = STYLES; title.textContent = "Graphics";
  const stateText = doc.createElement("p"), note = doc.createElement("p"), status = doc.createElement("p"), error = doc.createElement("p");
  stateText.className = "fc-graphics-current";
  status.className = "fc-graphics-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  error.className = "fc-graphics-error"; error.setAttribute("role", "alert");
  const fieldset = doc.createElement("fieldset"), legend = doc.createElement("legend");
  legend.textContent = "Rendering quality"; fieldset.append(legend);
  const id = `fc-graphics-${++nextPanel}`, inputs = new Map<GfxRequest, HTMLInputElement>();
  let disposed = false, pending: GfxRequest | undefined;
  const apply = (requested: GfxRequest): void => {
    const restoreFocus = root.contains(doc.activeElement);
    pending = requested;
    void options.controller.select(requested).then(() => { pending = undefined; }).catch(() => { /* State publishes the recoverable error. */ }).finally(() => {
      // Disabling the controls while applying can move focus to the body. Never steal it
      // from another panel if the player closed Settings before application finished.
      if (!disposed && restoreFocus && (doc.activeElement === doc.body || root.contains(doc.activeElement))) inputs.get(options.controller.get().requested)?.focus();
    });
  };
  for (const choice of GRAPHICS_CHOICES) {
    const label = doc.createElement("label"), input = doc.createElement("input"), text = doc.createElement("span"), name = doc.createElement("strong"), detail = doc.createElement("small");
    label.className = "fc-graphics-choice"; input.type = "radio"; input.name = id; input.value = choice.value;
    input.setAttribute("aria-label", choice.label); detail.id = `${id}-${choice.value}-detail`; input.setAttribute("aria-describedby", detail.id);
    input.addEventListener("change", () => { if (input.checked) apply(choice.value); });
    name.textContent = choice.label; detail.textContent = choice.detail; text.append(name, detail); label.append(input, text); fieldset.append(label); inputs.set(choice.value, input);
  }
  const retry = doc.createElement("button"); retry.type = "button"; retry.textContent = "Try graphics change again";
  retry.addEventListener("click", () => { if (pending) apply(pending); });
  root.append(style, title, stateText, fieldset, note, status, error, retry);
  const label = (value: string): string => GRAPHICS_CHOICES.find(choice => choice.value === value)?.label ?? value;
  const show = (state: GfxPreferenceState): void => {
    if (disposed) return;
    root.setAttribute("aria-busy", String(state.applying));
    for (const [request, input] of inputs) { input.checked = request === state.requested; input.disabled = state.applying; }
    stateText.textContent = `Using ${label(state.tier)}. ${state.requested === "auto" ? "Auto is selected." : `${label(state.requested)} is selected.`}`;
    if(state.reason.startsWith("Auto adapted"))stateText.textContent+=` ${state.reason}`;
    note.textContent = state.overrides.length ? "This link overrides graphics settings. Choosing a quality replaces those overrides."
      : state.requested === "auto" ? "Auto can adapt during play. Manual choices stay selected."
      : "This choice stays selected. GPU recovery can temporarily use Low.";
    status.textContent = state.applying ? `Applying ${label(pending ?? state.requested)}…`
      : state.safetyFallback ? `Graphics recovery is using ${label(state.tier)}. Your selected quality is retained.`
      : state.source === "url" ? "Using the quality from this link."
      : state.source === "settings" ? state.persisted ? "Graphics changed. Saved for this browser." : "Graphics changed for this session. Browser storage is unavailable."
      : state.source === "saved" ? "Using your saved quality." : "Using this device’s automatic quality.";
    error.textContent = state.error ?? ""; error.hidden = !state.error; retry.hidden = !state.error || !pending; retry.disabled = state.applying;
  };
  show(options.controller.get());
  const unsubscribe = options.controller.subscribe(show);
  return { element: root, dispose() { disposed = true; unsubscribe(); root.remove(); } };
}
