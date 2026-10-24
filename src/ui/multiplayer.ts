// "Play with friends": the private-room lobby, the Bot Sweep match HUD and the results card,
// and the controller that switches the page between the free-roam city and a relay match.
//
// The city is never stepped while a match runs and nothing in the match reads or writes it.
// It is autosaved when a match starts; a page that reloads into its room restores that autosave
// before rejoining; the match payout is applied once (by settlement id, kept in the save) and
// saved straight away.
import type { WorldFiles } from "../io/world-load.ts";
import { activeBody, DT, type SimInput, type SimState, type World } from "../sim/index.ts";
import { botSweepView } from "../sim/modes/botsweep.ts";
import { applyMatchSettlement, settledModeIds } from "../sim/modes/settlement.ts";
import { fetchLeaderboard, fetchMyStats, listRooms, RelayClient, type LeaderboardRow, type MyStats, type ClientInfo, type Seat } from "../net/client.ts";
import { MAX_PLAYERS, MODES, ROOM_CODE, WORLDS, type NetModeId, type Results, type RoomList, type WorldName } from "../net/protocol.ts";
import { worldFingerprint } from "../net/world-id.ts";
import { LOOK_NAMES, LOOK_SWATCHES, loadIdentity, randomName, saveIdentity, profileName, type Identity } from "../net/identity.ts";
import { formatMoney } from "./copy.ts";
import { QUICK_CHAT } from "../net/chat.ts";

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
  /** Where the guest identity lives (localStorage: one per device). */
  identityStorage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Each match player's chosen look (renderer colour slot), complete each time ({} after a match); bots keep their default. */
  onLooks?(looks: Readonly<Record<string, number>>): void;
  /** World point → CSS pixels in the game view and distance from the camera; null when behind it. */
  project?(x: number, y: number, z: number): { x: number; y: number; distance: number } | null;
}
export interface MatchView { prev: SimState; curr: SimState; alpha: number; playerId: string; ticksThisFrame: number }
export interface MultiplayerHook {
  available: boolean;
  /** After the frame is rendered: place other players' nametags over them. */
  overlay(): void;
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
.fc-mp{position:fixed;left:16px;top:96px;z-index:21;color:#f4f5ed;font:500 14px/1.4 system-ui,sans-serif;max-width:min(340px,calc(100vw - 32px));max-height:calc(100dvh - 112px);overflow-y:auto;overscroll-behavior:contain}
.fc-mp *{box-sizing:border-box}.fc-mp [hidden],.fc-mp-hud[hidden]{display:none!important}
.fc-mp button,.fc-mp input{font:inherit;border:1px solid #64838a;border-radius:8px;background:#142c35;color:inherit;padding:8px 12px;min-height:40px;cursor:pointer}
.fc-mp button:disabled{opacity:.5;cursor:default}.fc-mp button.fc-primary{background:#9af4c3;color:#0b1c17;border-color:#9af4c3}
.fc-mp input{width:9.5em;text-transform:uppercase;letter-spacing:.08em;background:#0b1c22}
.fc-mp-panel{margin-top:8px;padding:12px 14px;background:linear-gradient(145deg,#182e37f2,#0c171ef2);border:1px solid #64838a;border-radius:10px;display:grid;gap:8px}
.fc-mp-panel h2{font-size:15px;margin:0}.fc-mp-panel p{margin:0}.fc-mp-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.fc-mp-code{font:700 22px/1.2 ui-monospace,monospace;letter-spacing:.12em;color:#9af4c3}
.fc-mp ol{list-style:none;margin:0;padding:0;display:grid;gap:4px}.fc-mp ol li{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;background:#08171e99;border-radius:6px}.fc-mp ul{list-style:none;margin:0;padding:0;display:grid;gap:4px}.fc-mp li{display:flex;justify-content:space-between;gap:8px;padding:4px 8px;background:#08171e99;border-radius:6px}
.fc-mp li[data-connected=false]{opacity:.55}.fc-mp-swatch{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.4em;vertical-align:-.05em;border:1px solid #0006}.fc-mp-feed{position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:21;display:grid;gap:4px;pointer-events:none}.fc-mp-feed p{margin:0;padding:4px 10px;border-radius:8px;background:#08171ed9;color:#f4f5ed;font:600 13px/1.3 system-ui,sans-serif;text-align:center}.fc-mp-tags{position:fixed;inset:0;pointer-events:none;z-index:19}.fc-mp-tag{position:absolute;transform:translate(-50%,-100%);padding:2px 8px;border-radius:999px;background:#08171ecc;color:#f4f5ed;font:600 13px/1.3 system-ui,sans-serif;white-space:nowrap;text-shadow:0 1px 2px #000}.fc-mp-tag[data-team=rival]{border:1px solid #f08a6a}.fc-mp-tag[data-team=team]{border:1px solid #9af4c3}.fc-mp output{color:#c9d6d3;font-size:13px}
.fc-mp-hud{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:21;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;padding:8px 12px;background:#08171ee6;border:1px solid #55747b;border-radius:10px;color:#f4f5ed;font:600 14px/1.3 system-ui,sans-serif;max-width:calc(100vw - 24px)}
.fc-mp-hud strong{color:#9af4c3}.fc-mp-hud button{font:inherit;border:1px solid #64838a;border-radius:8px;background:#142c35;color:inherit;padding:6px 10px;cursor:pointer}
@media(max-width:600px){.fc-mp{top:auto;bottom:170px;left:10px;max-height:calc(100dvh - 186px)}.fc-mp-hud{top:auto;bottom:8px;font-size:12px}}`;

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
  if (!options.relayUrl || !WORLDS.includes(worldName)) return { available: false, inMatch: () => false, frame: () => null, overlay: () => {}, dispose: () => {} };
  const relayUrl = options.relayUrl;
  const storage = options.storage === undefined ? (() => { try { return win.sessionStorage; } catch { return null; } })() : options.storage;
  const fingerprint = worldFingerprint(options.files);
  const identityStore = options.identityStorage === undefined ? (() => { try { return win.localStorage; } catch { return null; } })() : options.identityStorage;
  let identity: Identity = loadIdentity(identityStore);
  const setIdentity = (next: Identity): void => { identity = next; saveIdentity(identityStore, next); lastStamp = ""; render(); };

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

  const client = new RelayClient({ url: relayUrl, world: options.world, worldName, fingerprint, identity: () => identity,
    onChange: (next) => { info = next; update(); }, onSeat: saveSeat, onResults: settle, onChat: (from, phrase) => addChat(from, phrase) });
  debug.available = true;
  debug.info = () => ({ ...client.info, members: [...client.info.members] });
  debug.match = () => client.match?.confirmed ?? null;
  debug.stats = () => client.match ? { ...client.match.stats, tick: client.match.tick } : null;

  const setInMatch = (next: boolean): void => {
    if (next === inMatch) return;
    inMatch = next; acc = 0; prevView = currView = null;
    if (next) options.city.save();
    emitLooks();
    options.onModeChange?.(next);
  };
  function update(): void {
    const phase = info?.phase ?? "none";
    // A match (or its results) owns the screen once a snapshot has arrived.
    setInMatch((phase === "match" || phase === "results") && !!client.match);
    emitLooks();
    launcher.textContent = phase === "none" ? "Play with friends" : `Room ${info?.code ?? ""}`;
    launcher.setAttribute("aria-expanded", String(!panel.hidden));
    if (phase === "lobby" || phase === "results" || info?.status === "error" || info?.status === "reconnecting") panel.hidden = false;
    render();
  }

  function render(): void {
    const phase = info?.phase ?? "none", status = info?.status ?? "offline";
    const stamp = JSON.stringify([phase, status, info?.message, info?.code, info?.members, info?.bots, info?.mode, board, mine, info?.results?.matchId, settlements.length, entering, codeDraft === "" ? 0 : 1, rooms]);
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    const focusedCode = doc.activeElement instanceof HTMLInputElement && panel.contains(doc.activeElement);
    const parts: HTMLElement[] = [];
    if (phase === "none") {
      parts.push(node("h2", undefined, "Play online"), node("p", undefined, "Bot Sweep (co-op) or Clean Streets (teams) · up to 4 players · bots fill empty seats"));
      const profile = node("div", "fc-mp-row");
      const myName = profileName(identity.name[0], identity.name[1]) ?? "Guest";
      profile.append(swatch(identity.look), node("strong", undefined, myName), button("New name", () => setIdentity({ ...identity, name: randomName() })));
      const looks = node("div", "fc-mp-row"); looks.setAttribute("role", "group"); looks.setAttribute("aria-label", "Look");
      LOOK_NAMES.forEach((label, look) => {
        const pick = button(label, () => setIdentity({ ...identity, look }), identity.look === look ? "fc-primary" : undefined);
        pick.setAttribute("aria-pressed", String(identity.look === look)); pick.prepend(swatch(look)); looks.append(pick);
      });
      parts.push(profile, looks);
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
      parts.push(form, roomList(busy), leaderboardBox());
      if (focusedCode) win.setTimeout(() => input.focus(), 0);
    } else if (phase === "lobby" && info) {
      const me = info.members.find((m) => m.id === info!.playerId), host = me?.host ?? false, allReady = info.members.every((m) => m.spectator || m.ready && m.connected);
      parts.push(node("h2", undefined, info.visibility === "public" ? "Public room" : "Private room"), node("div", "fc-mp-code", info.code));
      const link = new URL(win.location.href); link.searchParams.set("room", info.code);
      const copyLink = button("Copy invite link", () => { void win.navigator.clipboard?.writeText(link.href).then(() => { out.textContent = "Invite link copied."; }, () => { out.textContent = link.href; }); });
      parts.push(node("div", "fc-mp-row"));
      parts.at(-1)!.append(copyLink);
      parts.push(members(info));
      const playing = info.members.filter((m) => !m.spectator).length, free = MAX_PLAYERS - playing, alone = playing === 1;
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
      if (!me?.spectator) row.append(button(me?.ready ? "Not ready" : "Ready", () => client.ready(!me?.ready), me?.ready ? undefined : "fc-primary"));
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
      const row = node("div", "fc-mp-row");
      if (client.isHost()) row.append(button("Rematch", () => client.rematch(), "fc-primary"));
      row.append(button("Back to city", () => leave(), client.isHost() ? undefined : "fc-primary"));
      parts.push(row);
      if (!client.isHost() && !client.isSpectator()) parts.push(node("p", undefined, "The host can start a rematch with everyone still here."));
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
      const li = node("li"), joinable = r.players + (r.phase === "match" ? r.bots : 0) < r.max;
      const go = button(r.phase === "match" ? "Join in progress" : "Join", () => client.join(r.code)); go.disabled = busy || !joinable;
      const watch = button("Watch", () => client.spectate(r.code)); watch.disabled = busy;
      li.append(node("span", undefined, `${MODE_NAMES[r.mode] ?? r.mode} · ${r.code} · ${r.players}/${r.max} players${r.bots ? ` + ${r.bots} bots` : ""} · ${r.phase === "lobby" ? "in lobby" : "playing"}`), go, watch);
      list.append(li);
    }
    if (rooms.rooms.length) box.append(list);
    return box;
  }
  // Leaderboards (relay store): best single-match score per mode, this week or all time, and
  // this device's own totals. Names only: no other identifier ever reaches the page.
  let board: { mode: NetModeId; period: "week" | "all"; rows: LeaderboardRow[] | null; loading: boolean } = { mode: "botSweep", period: "week", rows: null, loading: false };
  let mine: MyStats | null = null, boardAt = 0;
  function loadBoard(): void {
    board = { ...board, loading: true }; boardAt = win.performance.now();
    const want = { mode: board.mode, period: board.period };
    void Promise.all([fetchLeaderboard(relayUrl, want.mode, want.period), fetchMyStats(relayUrl, identity.token)]).then(([rows, stats]) => {
      if (board.mode !== want.mode || board.period !== want.period) return;
      board = { ...board, rows, loading: false }; mine = stats; lastStamp = ""; render();
    });
  }
  function leaderboardBox(): HTMLElement {
    const box = node("section"); box.setAttribute("aria-label", "Leaderboard");
    const tabs = node("div", "fc-mp-row");
    for (const mode of MODES) { const b = button(MODE_NAMES[mode], () => { board = { ...board, mode, rows: null }; loadBoard(); render(); }); b.setAttribute("aria-pressed", String(board.mode === mode)); tabs.append(b); }
    for (const period of ["week", "all"] as const) { const b = button(period === "week" ? "This week" : "All time", () => { board = { ...board, period, rows: null }; loadBoard(); render(); }); b.setAttribute("aria-pressed", String(board.period === period)); tabs.append(b); }
    box.append(node("h2", undefined, "Leaderboard"), tabs);
    if (board.rows === null) box.append(node("p", undefined, board.loading ? "Loading…" : "No leaderboard on this server."));
    else if (!board.rows.length) box.append(node("p", undefined, "No matches yet. Be the first."));
    else {
      const list = node("ol"); list.setAttribute("aria-label", "Top players");
      for (const r of board.rows) { const li = node("li"); li.append(swatch(r.look), node("span", undefined, `${r.rank}. ${r.name}`), node("span", undefined, `${r.best} pts · ${r.wins}/${r.matches} won`)); list.append(li); }
      box.append(list);
    }
    const own = mine?.modes[board.mode];
    box.append(node("p", undefined, own ? `You: best ${own.best} pts · ${own.wins} wins in ${own.matches} ${MODE_NAMES[board.mode]} matches` : "You: no matches yet."));
    return box;
  }

  function refreshRooms(): void {
    const now = win.performance.now();
    if (roomsLoading || panel.hidden || (info?.phase ?? "none") !== "none" || now - roomsAt < 5000) return;
    roomsLoading = true; roomsAt = now;
    void listRooms(relayUrl, worldName).then((list) => { rooms = list; roomsLoading = false; lastStamp = ""; render(); });
    if (now - boardAt > 30_000) loadBoard();
  }
  const roomTimer = win.setInterval(refreshRooms, 1000);

  function swatch(look: number): HTMLElement {
    const dot = node("span", "fc-mp-swatch"); dot.setAttribute("aria-hidden", "true");
    dot.style.background = `#${(LOOK_SWATCHES[look] ?? LOOK_SWATCHES[0]).toString(16).padStart(6, "0")}`;
    return dot;
  }
  function members(current: ClientInfo): HTMLUListElement {
    const list = node("ul"); list.setAttribute("aria-label", "Players");
    for (const m of current.members) {
      const li = node("li"); li.dataset.connected = String(m.connected);
      li.append(swatch(m.look), node("span", undefined, `${m.name}${m.id === current.playerId ? " (you)" : ""}${m.host ? " · host" : ""}`), node("span", undefined, !m.connected ? "away" : m.spectator ? "watching" : m.ready ? "ready" : "not ready"));
      list.append(li);
    }
    return list;
  }

  // The match HUD is built once; only its text changes, so its buttons never move under a click.
  const hudTitle = node("span", undefined, "Bot Sweep"), hudClock = node("strong"), hudUnits = node("span"), hudLives = node("span"), hudScore = node("span"), hudTeam = node("span"), hudNet = node("output");
  const endButton = button("End match", () => client.end()), leaveButton = button("Leave match", () => leave());
  const nextButton = button("Next player", () => { follow = nextFollow(); });
  const chatBar = node("div", "fc-mp-row"); chatBar.setAttribute("role", "group"); chatBar.setAttribute("aria-label", "Quick chat");
  QUICK_CHAT.forEach((phrase, i) => { const b = button(`${i + 1} ${phrase}`, () => client.quickChat(i)); b.title = `Key ${i + 1}`; chatBar.append(b); });
  hud.append(hudTitle, hudClock, hudUnits, hudLives, hudScore, hudTeam, hudNet, nextButton, endButton, leaveButton, chatBar);
  // Quick chat: keys 1–6 during a match (never while typing). Messages fade after 6 s.
  const feed = node("div", "fc-mp-feed"); feed.setAttribute("role", "log"); feed.setAttribute("aria-label", "Chat"); feed.hidden = true;
  options.host.append(feed);
  const chats: Array<{ text: string; until: number }> = [];
  function addChat(from: string, phrase: number): void {
    const who = info?.members.find((m) => m.id === from)?.name ?? "Someone", text = QUICK_CHAT[phrase];
    if (!text) return;
    chats.push({ text: `${who}: ${text}`, until: win.performance.now() + 6000 });
    while (chats.length > 4) chats.shift();
    renderFeed();
  }
  function renderFeed(): void {
    const t = win.performance.now();
    while (chats.length && chats[0]!.until <= t) chats.shift();
    feed.hidden = !inMatch || !chats.length;
    const text = chats.map((c) => c.text).join("\n");
    if (feed.dataset.text !== text) { feed.dataset.text = text; feed.replaceChildren(...chats.map((c) => node("p", undefined, c.text))); }
  }
  const chatKeys = (event: KeyboardEvent): void => {
    if (!inMatch || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const n = /^Digit([1-9])$/.exec(event.code);
    if (n && Number(n[1]) <= QUICK_CHAT.length) client.quickChat(Number(n[1]) - 1);
  };
  win.addEventListener("keydown", chatKeys);
  // Spectators follow one player (cycling with Next player); players follow themselves.
  let follow = "";
  function nextFollow(): string {
    const ids = client.match ? Object.keys(client.match.confirmed.players).sort() : [];
    if (!ids.length) return "";
    const i = ids.indexOf(follow);
    return ids[(i + 1) % ids.length]!;
  }
  const setText = (el: HTMLElement, text: string): void => { if (el.textContent !== text) el.textContent = text; };
  function renderHud(): void {
    const state = client.match?.confirmed, view = state ? botSweepView(state) : null;
    if (!inMatch || !view || !info) { hud.hidden = true; return; }
    const spectating = client.isSpectator();
    if (spectating && (!follow || !state!.players[follow])) follow = nextFollow();
    const meId = spectating ? follow : info.playerId, me = view.players[meId];
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
    const watched = info.members.find((m) => m.id === follow)?.name ?? (follow.startsWith("bot-") ? `Bot ${follow.slice(4)}` : follow);
    setText(hudTeam, spectating ? `Watching ${watched}` : `Team ${info.members.filter((m) => m.connected && !m.spectator).length}/${info.members.filter((m) => !m.spectator).length}`);
    nextButton.hidden = !spectating;
    chatBar.hidden = view.phase !== "active";
    setText(hudNet, net); hudNet.hidden = !net;
    endButton.hidden = view.phase !== "active" || !client.isHost();
    leaveButton.hidden = view.phase !== "active";
    setText(leaveButton, spectating ? "Stop watching" : "Leave match");
    hud.hidden = false;
    renderFeed();
  }

  // Nametags (docs/design.md, Seeing each other): other players' names over them, team-coloured in
  // Clean Streets, fading out by 150 m; your own is never drawn. Render-only: never in the sim.
  const tagLayer = node("div", "fc-mp-tags"); tagLayer.setAttribute("aria-hidden", "true");
  options.host.append(tagLayer);
  const tags = new Map<string, HTMLElement>();
  let lastLooks = "";
  function overlay(): void {
    const state = currView, me = info?.playerId ?? "";
    if (!inMatch || !state || !options.project) { if (tags.size) { tags.clear(); tagLayer.replaceChildren(); } return; }
    const view = botSweepView(state), seen = new Set<string>();
    for (const id of Object.keys(state.players).sort()) {
      if (id === me) continue;
      const body = activeBody(state.players[id]!), onFoot = state.players[id]!.mode === "foot";
      const at = options.project(body.x, body.y + (onFoot ? 2.1 : 1.9), body.z);
      if (!at || at.distance > 150) continue;
      seen.add(id);
      let tag = tags.get(id);
      if (!tag) { tag = node("div", "fc-mp-tag"); tags.set(id, tag); tagLayer.append(tag); }
      const member = info?.members.find((m) => m.id === id);
      const text = member?.name ?? (id.startsWith("bot-") ? `Bot ${id.slice(4)}` : id);
      if (tag.textContent !== text) tag.textContent = text;
      tag.dataset.team = view?.mode === "cleanStreets" ? (view.players[id]?.team === view.players[me]?.team ? "team" : "rival") : "team";
      tag.style.left = `${at.x}px`; tag.style.top = `${at.y}px`;
      tag.style.opacity = String(at.distance < 100 ? 1 : Math.max(0, (150 - at.distance) / 50));
    }
    for (const [id, tag] of tags) if (!seen.has(id)) { tag.remove(); tags.delete(id); }
  }
  function emitLooks(): void {
    const looks: Record<string, number> = {};
    // Only while a match owns the screen: in the city, "p1" is always the local player.
    if (inMatch) for (const m of info?.members ?? []) looks[m.id] = m.look;
    const key = JSON.stringify(looks);
    if (key !== lastLooks) { lastLooks = key; options.onLooks?.(looks); }
  }

  function leave(): void {
    boardAt = 0;
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
      const spectating = client.isSpectator();
      while (acc >= DT) { if (!spectating) client.sample(sample()); acc -= DT; ticks++; }
      const started = performance.now(), budget = match.queued > 12 ? 150 : 24;
      // Catch up within a frame budget (larger when well behind), so a slow device keeps pace.
      const steps = client.advance(ticks, () => performance.now() - started > budget);
      const next = match.predicted();
      if (!currView) prevView = currView = next;
      else if (steps || next !== currView) { prevView = currView; currView = next; }
      renderHud();
      return { prev: prevView!, curr: currView, alpha: Math.min(1, acc / DT), playerId: spectating ? (follow || nextFollow()) : info?.playerId ?? match.playerId, ticksThisFrame: steps };
    },
    overlay,
    dispose() { win.clearInterval(roomTimer); win.removeEventListener("keydown", chatKeys); client.dispose(); root.remove(); hud.remove(); tagLayer.remove(); feed.remove(); },
  };
}
