// "Play with friends": the private-room lobby, the Bot Sweep match HUD and the results card,
// and the controller that switches the page between the free-roam city and a relay match.
//
// The city is never stepped while a match runs and nothing in the match reads or writes it.
// It is autosaved when a match starts; a page that reloads into its room restores that autosave
// before rejoining; the match payout is applied once (by settlement id, kept in the save) and
// saved straight away.
import type { WorldFiles } from "../io/world-load.ts";
import { DT, type SimInput, type SimState, type World } from "../sim/index.ts";
import { botSweepView } from "../sim/modes/botsweep.ts";
import { applyMatchSettlement, settledModeIds } from "../sim/modes/settlement.ts";
import { listRooms, RelayClient, type ClientInfo, type Seat } from "../net/client.ts";
import { MAX_PLAYERS, MODES, ROOM_CODE, WORLDS, type NetModeId, type Results, type RoomList, type WorldName } from "../net/protocol.ts";
import { worldFingerprint } from "../net/world-id.ts";
import { formatMoney } from "./copy.ts";

export interface MultiplayerCity {
  playerId: string;
  get(): SimState;
  set(state: SimState): void;
  /** Persist the city now (autosave). */
  save(): void;
  /** Replace the city from its autosave, if there is one. */
  restoreAutosave(): Promise<boolean>;
}
export interface MultiplayerOptions {
  host: HTMLElement;
  relayUrl: string | null;
  world: World;
  files: WorldFiles;
  worldName: string;
  city: MultiplayerCity;
  /** Where the seat token lives across reloads (sessionStorage: one tab, one seat). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** The page's own search string, for ?room= invitations. */
  search?: string;
  /** The page switched between the city and a match. */
  onModeChange?(inMatch: boolean): void;
}
export interface MatchView { prev: SimState; curr: SimState; alpha: number; playerId: string; ticksThisFrame: number }
export interface MultiplayerHook {
  available: boolean;
  /** True while a relay match (or its results) owns the screen. */
  inMatch(): boolean;
  /** Advance the match by one render frame; `sample` reads this tick's controls. */
  frame(dtSeconds: number, sample: () => SimInput): MatchView | null;
  dispose(): void;
}
interface Settlement { matchId: string; id: string; cashCents: number; xp: number; status: "paid" | "already" | "none" }
export interface NetDebug {
  available: boolean;
  info(): ClientInfo | null;
  match(): SimState | null;
  stats(): { frames: number; mismatches: number; snapshots: number; predicted: number; tick: number } | null;
  settlements(): Settlement[];
  settledIds(): readonly string[];
}
declare global { interface Window { __fogcityNet?: NetDebug } }

const SEAT_KEY = "fog-city.relay.seat";
const STYLE = `
.fc-mp{position:fixed;left:16px;top:96px;z-index:21;color:#f4f5ed;font:500 14px/1.4 system-ui,sans-serif;max-width:min(340px,calc(100vw - 32px))}
.fc-mp *{box-sizing:border-box}.fc-mp [hidden]{display:none!important}
.fc-mp button,.fc-mp input{font:inherit;border:1px solid #64838a;border-radius:8px;background:#142c35;color:inherit;padding:8px 12px;min-height:40px;cursor:pointer}
.fc-mp button:disabled{opacity:.5;cursor:default}.fc-mp button.fc-primary{background:#9af4c3;color:#0b1c17;border-color:#9af4c3}
.fc-mp input{width:9.5em;text-transform:uppercase;letter-spacing:.08em;background:#0b1c22}
.fc-mp-panel{margin-top:8px;padding:12px 14px;background:linear-gradient(145deg,#182e37f2,#0c171ef2);border:1px solid #64838a;border-radius:10px;display:grid;gap:8px}
.fc-mp-panel h2{font-size:15px;margin:0}.fc-mp-panel p{margin:0}.fc-mp-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.fc-mp-code{font:700 22px/1.2 ui-monospace,monospace;letter-spacing:.12em;color:#9af4c3}
.fc-mp ul{list-style:none;margin:0;padding:0;display:grid;gap:4px}.fc-mp li{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;background:#08171e99;border-radius:6px}
.fc-mp li[data-connected=false]{opacity:.55}.fc-mp output{color:#c9d6d3;font-size:13px}
.fc-mp-hud{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:21;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;padding:8px 12px;background:#08171ee6;border:1px solid #55747b;border-radius:10px;color:#f4f5ed;font:600 14px/1.3 system-ui,sans-serif;max-width:calc(100vw - 24px)}
.fc-mp-hud strong{color:#9af4c3}.fc-mp-hud button{font:inherit;border:1px solid #64838a;border-radius:8px;background:#142c35;color:inherit;padding:6px 10px;cursor:pointer}
@media(max-width:600px){.fc-mp{top:auto;bottom:170px;left:10px}.fc-mp-hud{top:auto;bottom:8px;font-size:12px}}`;

function reason(text: string): string {
  return text === "sweep-complete" ? "Sweep complete: the pilot is cancelled." : text === "relay-update" ? "Time's up: the Update Relay pushed its firmware."
    : text === "lives" ? "Out of lives." : text === "ended" ? "The host ended the match." : text === "agi" ? "AGI Achieved (Allegedly)." : text === "time" ? "Time's up: the BotBounty board is closed." : "Match over.";
}
const MODE_NAMES: Record<NetModeId, string> = { botSweep: "Bot Sweep", cleanStreets: "Clean Streets" };
const MODE_BLURBS: Record<NetModeId, string> = {
  botSweep: "Co-op: melt every beta unit and the Update Relay before the 12-minute clock runs out.",
  cleanStreets: "Two teams race: most points from the BotBounty board in 8 minutes. Alt-fire lobs flowers at rivals (+25, they can't spray for 1.5 s).",
};
function clock(ticks: number): string { const s = Math.ceil(ticks / 60); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

/** Mount once at boot. With no relay configured it adds nothing and the game stays single-player. */
export function mountMultiplayer(options: MultiplayerOptions): MultiplayerHook {
  const doc = options.host.ownerDocument, win = doc.defaultView!;
  const worldName = options.worldName as WorldName;
  const settlements: Settlement[] = [];
  const debug: NetDebug = { available: false, info: () => null, match: () => null, stats: () => null, settlements: () => settlements.map((s) => ({ ...s })), settledIds: () => settledModeIds(options.city.get()) };
  win.__fogcityNet = debug;
  if (!options.relayUrl || !WORLDS.includes(worldName)) return { available: false, inMatch: () => false, frame: () => null, dispose: () => {} };
  const relayUrl = options.relayUrl;
  const storage = options.storage === undefined ? (() => { try { return win.sessionStorage; } catch { return null; } })() : options.storage;
  const fingerprint = worldFingerprint(options.files);

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => { const e = doc.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
  const button = (label: string, fn: () => void, className?: string): HTMLButtonElement => { const b = node("button", className, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  const root = node("section", "fc-mp"); root.setAttribute("aria-label", "Play with friends");
  const style = node("style"); style.textContent = STYLE; root.append(style);
  const launcher = button("Play with friends", () => { panel.hidden = !panel.hidden; if (!panel.hidden) { roomsAt = 0; refreshRooms(); render(); } });
  launcher.setAttribute("aria-expanded", "false");
  const panel = node("div", "fc-mp-panel"); panel.hidden = true; panel.setAttribute("role", "group"); panel.setAttribute("aria-label", "Multiplayer lobby");
  const hud = node("div", "fc-mp-hud"); hud.hidden = true; hud.setAttribute("role", "status"); hud.setAttribute("aria-label", "Online match");
  root.append(launcher, panel);
  options.host.append(root, hud);
  // Typing a room code never drives the car or fires.
  for (const el of [panel, hud]) for (const type of ["keydown", "keyup"] as const) el.addEventListener(type, (e) => { if ((e as KeyboardEvent).code !== "Escape") e.stopPropagation(); });

  let info: ClientInfo | null = null, inMatch = false, entering = false, acc = 0;
  let codeDraft = new URLSearchParams(options.search ?? win.location.search).get("room")?.toUpperCase() ?? "";
  if (codeDraft && !ROOM_CODE.test(codeDraft)) codeDraft = "";
  let prevView: SimState | null = null, currView: SimState | null = null, viewMatch = "";
  let lastStamp = "";

  const saveSeat = (seat: Seat | null): void => {
    try { if (seat) storage?.setItem(SEAT_KEY, JSON.stringify(seat)); else storage?.removeItem(SEAT_KEY); } catch { /* private mode: no rejoin after reload */ }
  };
  const storedSeat = (): Seat | null => {
    try {
      const value = JSON.parse(storage?.getItem(SEAT_KEY) ?? "null") as Seat | null;
      return value && value.url === relayUrl && value.world === worldName && ROOM_CODE.test(value.code) && /^[a-f0-9]{32}$/.test(value.token) ? value : null;
    } catch { return null; }
  };

  const settle = (results: Results, playerId: string): void => {
    const payout = results.payouts.find((p) => p.playerId === playerId);
    if (!payout) { settlements.push({ matchId: results.matchId, id: "", cashCents: 0, xp: 0, status: "none" }); render(); return; }
    if (settlements.some((s) => s.id === payout.id && s.status === "paid")) { render(); return; }
    const before = options.city.get(), after = applyMatchSettlement(before, payout, options.city.playerId);
    settlements.push({ matchId: results.matchId, id: payout.id, cashCents: payout.cashCents, xp: payout.xp, status: after === before ? "already" : "paid" });
    if (after !== before) { options.city.set(after); options.city.save(); }
    render();
  };

  const client = new RelayClient({ url: relayUrl, world: options.world, worldName, fingerprint,
    onChange: (next) => { info = next; update(); }, onSeat: saveSeat, onResults: settle });
  debug.available = true;
  debug.info = () => ({ ...client.info, members: [...client.info.members] });
  debug.match = () => client.match?.confirmed ?? null;
  debug.stats = () => client.match ? { ...client.match.stats, tick: client.match.tick } : null;

  const setInMatch = (next: boolean): void => {
    if (next === inMatch) return;
    inMatch = next; acc = 0; prevView = currView = null;
    if (next) options.city.save();
    options.onModeChange?.(next);
  };
  function update(): void {
    const phase = info?.phase ?? "none";
    // A match (or its results) owns the screen once a snapshot has arrived.
    setInMatch((phase === "match" || phase === "results") && !!client.match);
    launcher.textContent = phase === "none" ? "Play with friends" : `Room ${info?.code ?? ""}`;
    launcher.setAttribute("aria-expanded", String(!panel.hidden));
    if (phase === "lobby" || phase === "results" || info?.status === "error" || info?.status === "reconnecting") panel.hidden = false;
    render();
  }

  function render(): void {
    const phase = info?.phase ?? "none", status = info?.status ?? "offline";
    const stamp = JSON.stringify([phase, status, info?.message, info?.code, info?.members, info?.bots, info?.mode, info?.results?.matchId, settlements.length, entering, codeDraft === "" ? 0 : 1, rooms]);
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    const focusedCode = doc.activeElement instanceof HTMLInputElement && panel.contains(doc.activeElement);
    const parts: HTMLElement[] = [];
    if (phase === "none") {
      parts.push(node("h2", undefined, "Play online"), node("p", undefined, "Bot Sweep (co-op) or Clean Streets (teams) · up to 4 players · bots fill empty seats"));
      const quick = button("Play online", () => client.quick(), "fc-primary");
      const create = button("Create private room", () => client.create());
      const form = node("form", "fc-mp-row"), label = node("label"), input = node("input");
      input.name = "code"; input.maxLength = 8; input.autocomplete = "off"; input.spellcheck = false; input.value = codeDraft; input.setAttribute("aria-label", "Room code"); input.placeholder = "ROOM CODE";
      input.addEventListener("input", () => { codeDraft = input.value.toUpperCase(); });
      label.append(input);
      const join = node("button", undefined, "Join"); join.type = "submit";
      form.append(label, join);
      form.addEventListener("submit", (e) => { e.preventDefault(); const code = input.value.trim().toUpperCase(); if (ROOM_CODE.test(code)) client.join(code); else { out.textContent = "Room codes are 8 letters and digits."; } });
      const busy = status === "connecting" || status === "reconnecting" || entering;
      create.disabled = join.disabled = input.disabled = quick.disabled = busy;
      parts.push(node("div", "fc-mp-row"));
      parts.at(-1)!.append(quick, create);
      parts.push(form, roomList(busy));
      if (focusedCode) win.setTimeout(() => input.focus(), 0);
    } else if (phase === "lobby" && info) {
      const me = info.members.find((m) => m.id === info!.playerId), host = me?.host ?? false, allReady = info.members.every((m) => m.ready && m.connected);
      parts.push(node("h2", undefined, info.visibility === "public" ? "Public room" : "Private room"), node("div", "fc-mp-code", info.code));
      const link = new URL(win.location.href); link.searchParams.set("room", info.code);
      const copyLink = button("Copy invite link", () => { void win.navigator.clipboard?.writeText(link.href).then(() => { out.textContent = "Invite link copied."; }, () => { out.textContent = link.href; }); });
      parts.push(node("div", "fc-mp-row"));
      parts.at(-1)!.append(copyLink);
      parts.push(members(info));
      const free = MAX_PLAYERS - info.members.length, alone = info.members.length === 1;
      const modes = node("div", "fc-mp-row"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Mode");
      for (const mode of MODES) {
        const pick = button(MODE_NAMES[mode], () => client.setMode(mode), info.mode === mode ? "fc-primary" : undefined);
        pick.setAttribute("aria-pressed", String(info.mode === mode)); pick.disabled = !host;
        modes.append(pick);
      }
      parts.push(modes, node("p", undefined, MODE_BLURBS[info.mode]));
      const bots = node("div", "fc-mp-row");
      const botLabel = node("span", undefined, `Bot teammates: ${info.bots}`);
      if (host) {
        const fewer = button("Fewer bots", () => client.setBots(info!.bots - 1)), more = button("Add bot", () => client.setBots(info!.bots + 1));
        fewer.disabled = info.bots <= 0; more.disabled = info.bots >= free;
        bots.append(botLabel, fewer, more);
      } else bots.append(botLabel);
      parts.push(bots);
      const row = node("div", "fc-mp-row");
      row.append(button(me?.ready ? "Not ready" : "Ready", () => client.ready(!me?.ready), me?.ready ? undefined : "fc-primary"));
      if (host) { const start = button(alone && info.bots === 0 ? "Start solo practice" : `Start ${MODE_NAMES[info.mode]}`, () => client.start(), "fc-primary"); start.disabled = !allReady; row.append(start); }
      row.append(button("Leave room", () => leave()));
      parts.push(row, node("p", undefined, alone && info.visibility === "public" ? "Nobody else is here yet: wait for players, add bot teammates, or play solo." : host ? (allReady ? "Everyone is ready." : "Start when everyone is ready.") : "The host starts the match when everyone is ready."));
    } else if (phase === "results" && info?.results) {
      const result = info.results.result, mine = settlements.filter((s) => s.matchId === info!.results!.matchId).at(-1);
      const won = result.winners.includes(info.playerId);
      const teams = info.mode === "cleanStreets" && result.reason !== "ended";
      parts.push(node("h2", undefined, won ? (teams ? "Your team won!" : "You won the sweep!") : teams && !result.winners.length ? "A draw" : "Match over"), node("p", undefined, reason(result.reason)));
      if (mine?.status === "paid") parts.push(node("p", undefined, `+${formatMoney(mine.cashCents)} · +${mine.xp} XP added to your city.`));
      else if (mine?.status === "already") parts.push(node("p", undefined, `This match's payout (+${formatMoney(mine.cashCents)} · +${mine.xp} XP) is already in your city.`));
      parts.push(button("Back to city", () => leave(), "fc-primary"));
    } else if (phase === "match") {
      parts.push(node("p", undefined, "Match in progress."), button("Leave match", () => leave()));
    }
    if (status === "error" || (phase === "none" && info?.message && status !== "connecting")) {
      parts.push(button("Dismiss", () => { info = null; lastStamp = ""; render(); }));
    }
    const out = node("output"); out.setAttribute("aria-live", "polite");
    out.textContent = status === "error" || status === "reconnecting" || status === "connecting" ? info?.message ?? "" : info?.message && info.message !== "Connected" ? info.message : "";
    panel.replaceChildren(...parts, out);
    panel.hidden = panel.hidden && phase === "none" && status !== "error";
    root.hidden = inMatch && phase === "match";
  }

  let rooms: RoomList | null = null, roomsAt = 0, roomsLoading = false;
  /** The public rooms, refreshed every 5 s while the lobby browser is open. */
  function roomList(busy: boolean): HTMLElement {
    const box = node("div");
    if (!rooms) { box.append(node("p", undefined, roomsLoading ? "Looking for public rooms…" : "Public rooms: none listed.")); return box; }
    box.append(node("p", undefined, `${rooms.online} online · ${rooms.rooms.length} public room${rooms.rooms.length === 1 ? "" : "s"}`));
    const list = node("ul"); list.setAttribute("aria-label", "Public rooms");
    for (const r of rooms.rooms) {
      const li = node("li"), joinable = r.phase === "lobby" && r.players < r.max;
      const go = button("Join", () => client.join(r.code)); go.disabled = busy || !joinable;
      li.append(node("span", undefined, `${MODE_NAMES[r.mode] ?? r.mode} · ${r.code} · ${r.players}/${r.max} players${r.bots ? ` + ${r.bots} bots` : ""} · ${r.phase === "lobby" ? "in lobby" : "playing"}`), go);
      list.append(li);
    }
    if (rooms.rooms.length) box.append(list);
    return box;
  }
  function refreshRooms(): void {
    const now = win.performance.now();
    if (roomsLoading || panel.hidden || (info?.phase ?? "none") !== "none" || now - roomsAt < 5000) return;
    roomsLoading = true; roomsAt = now;
    void listRooms(relayUrl, worldName).then((list) => { rooms = list; roomsLoading = false; lastStamp = ""; render(); });
  }
  const roomTimer = win.setInterval(refreshRooms, 1000);

  function members(current: ClientInfo): HTMLUListElement {
    const list = node("ul"); list.setAttribute("aria-label", "Players");
    for (const m of current.members) {
      const li = node("li"); li.dataset.connected = String(m.connected);
      li.append(node("span", undefined, `${m.name}${m.id === current.playerId ? " (you)" : ""}${m.host ? " · host" : ""}`), node("span", undefined, !m.connected ? "away" : m.ready ? "ready" : "not ready"));
      list.append(li);
    }
    return list;
  }

  // The match HUD is built once; only its text changes, so its buttons never move under a click.
  const hudTitle = node("span", undefined, "Bot Sweep"), hudClock = node("strong"), hudUnits = node("span"), hudLives = node("span"), hudScore = node("span"), hudTeam = node("span"), hudNet = node("output");
  const endButton = button("End match", () => client.end()), leaveButton = button("Leave match", () => leave());
  hud.append(hudTitle, hudClock, hudUnits, hudLives, hudScore, hudTeam, hudNet, endButton, leaveButton);
  const setText = (el: HTMLElement, text: string): void => { if (el.textContent !== text) el.textContent = text; };
  function renderHud(): void {
    const state = client.match?.confirmed, view = state ? botSweepView(state) : null;
    if (!inMatch || !view || !info) { hud.hidden = true; return; }
    const me = view.players[info.playerId];
    const net = info.status !== "connected" ? info.message : client.match?.recovering ? "Resynchronising…" : info.rttMs ? `${Math.round(info.rttMs)} ms` : "";
    setText(hudClock, clock(view.remainingTicks));
    setText(hudTitle, MODE_NAMES[view.mode]);
    if (view.mode === "cleanStreets") {
      const mine = me?.team ?? 0;
      setText(hudUnits, `Bounties left ${view.objectivesRemaining}`);
      setText(hudLives, `Your team ${view.teamScores[mine] ?? 0} : ${view.teamScores[1 - mine] ?? 0} Rivals`);
    } else {
      setText(hudUnits, `Units left ${view.objectivesRemaining}${view.relayStanding ? " (Relay up)" : ""}`);
      setText(hudLives, `Lives ${view.lives}`);
    }
    setText(hudScore, `Score ${me?.score ?? 0}${me?.down ? " · DOWN" : me?.distracted ? " · flowers!" : ""}`);
    setText(hudTeam, `Team ${info.members.filter((m) => m.connected).length}/${info.members.length}`);
    setText(hudNet, net); hudNet.hidden = !net;
    endButton.hidden = view.phase !== "active" || !client.isHost();
    leaveButton.hidden = view.phase !== "active";
    hud.hidden = false;
  }

  function leave(): void {
    client.leave();
    info = null; lastStamp = "";
    setInMatch(false);
    panel.hidden = true;
    render(); renderHud();
  }

  // A seat from before a reload: put the city back as it was saved, then take the seat again.
  const seat = storedSeat();
  if (seat) {
    entering = true; panel.hidden = false; render();
    void options.city.restoreAutosave().catch(() => false).finally(() => { entering = false; client.rejoin(seat); });
  } else if (codeDraft) { panel.hidden = false; render(); }
  else render();

  return {
    available: true,
    inMatch: () => inMatch,
    frame(dtSeconds, sample) {
      const match = client.match;
      if (!inMatch || !match) return null;
      if (viewMatch !== match.matchId) { viewMatch = match.matchId; prevView = currView = null; }
      acc += Math.min(Math.max(0, dtSeconds), 0.25);
      let ticks = 0;
      while (acc >= DT) { client.sample(sample()); acc -= DT; ticks++; }
      const started = performance.now(), budget = match.queued > 12 ? 150 : 24;
      // Catch up within a frame budget (larger when well behind), so a slow device keeps pace.
      const steps = client.advance(ticks, () => performance.now() - started > budget);
      const next = match.predicted();
      if (!currView) prevView = currView = next;
      else if (steps || next !== currView) { prevView = currView; currView = next; }
      renderHud();
      return { prev: prevView!, curr: currView, alpha: Math.min(1, acc / DT), playerId: info?.playerId ?? match.playerId, ticksThisFrame: steps };
    },
    dispose() { win.clearInterval(roomTimer); client.dispose(); root.remove(); hud.remove(); },
  };
}
