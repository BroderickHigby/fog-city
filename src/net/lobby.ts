import type { WorldFiles } from "../io/world-load.ts";
import type { SimInput, SimState, World } from "../sim/index.ts";
import { RelayClient, type ConnectionInfo } from "./client.ts";
import { WORLDS, type WorldName } from "./protocol.ts";
import { worldFingerprint } from "./world-id.ts";

declare global {
  interface Window {
    __fogcityNet?: { info(): ConnectionInfo | null; confirmed(): SimState | null };
  }
}

/** Small optional lobby. Network activity starts only when the player chooses create or join. */
export function mountLobby(world: World, files: WorldFiles, worldName: string, callbacks: {
  onConnecting(): void;
  onState(state: SimState, playerId: string): void;
  onDisconnect(): void;
  onFocus(): void;
}): { active(): boolean; sample(input: SimInput): void } {
  const panel = document.createElement("details");
  panel.id = "multiplayer";
  const style = document.createElement("style");
  style.textContent = `#multiplayer{position:fixed;right:12px;top:12px;z-index:4;max-width:min(300px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;border:1px solid #718295;border-radius:8px;background:#111c2bf2;color:#edf2f8;font:14px/1.4 system-ui}#multiplayer summary{cursor:pointer}#multiplayer button,#multiplayer input{font:inherit;border:1px solid #718295;border-radius:5px;padding:6px;margin:5px 4px 5px 0}#multiplayer button{cursor:pointer;background:#d9e7fc;color:#14243a}#multiplayer button:disabled{opacity:.5;cursor:default}#multiplayer input{width:145px;text-transform:uppercase;background:#182c43;color:white}#multiplayer p{margin:7px 0}#multiplayer output{display:block;overflow-wrap:anywhere}#multiplayer ul{padding-left:20px;margin:6px 0}`;
  document.head.append(style);
  panel.innerHTML = `<summary>Play with friends</summary><p>Private room · up to 4 players</p><button type="button" data-create>Create room</button><form><label>Room code <input name="code" maxlength="10" autocomplete="off" spellcheck="false" pattern="[A-Za-z2-9]{10}" required></label><button type="submit" data-join>Join</button></form><output aria-live="polite">Create a room or enter an invitation code.</output><ul aria-label="Players"></ul><button type="button" data-leave hidden>Leave room</button>`;
  document.body.append(panel);
  const create = panel.querySelector<HTMLButtonElement>("[data-create]")!;
  const join = panel.querySelector<HTMLButtonElement>("[data-join]")!;
  const leave = panel.querySelector<HTMLButtonElement>("[data-leave]")!;
  const code = panel.querySelector<HTMLInputElement>("input")!;
  const output = panel.querySelector<HTMLOutputElement>("output")!;
  const list = panel.querySelector<HTMLUListElement>("ul")!;
  let client: RelayClient | null = null;
  let connecting = false;
  let lastPlayers = "";
  let generation = 0;
  const update = (info: ConnectionInfo): void => {
    const active = info.status === "connecting" || info.status === "connected" || info.status === "recovering";
    connecting = info.status === "connecting";
    create.disabled = join.disabled = code.disabled = active;
    leave.hidden = !active;
    output.textContent = info.code && active ? `Room ${info.code} · ${Object.keys(info.players).length}/4 players${info.status === "recovering" ? " · synchronizing" : ""}` : info.message;
    const key = JSON.stringify(info.players);
    if (key !== lastPlayers) {
      lastPlayers = key;
      list.replaceChildren(...Object.entries(info.players).map(([id, name]) => {
        const li = document.createElement("li");
        li.textContent = name + (id === info.playerId ? " (you)" : "");
        return li;
      }));
    }
  };
  const connect = async (roomCode?: string): Promise<void> => {
    if (connecting || !WORLDS.includes(worldName as WorldName)) return;
    connecting = true;
    create.disabled = join.disabled = true;
    output.textContent = "Checking game version…";
    const current = ++generation;
    try {
      const fingerprint = await worldFingerprint(files);
      if (current !== generation) return;
      client = new RelayClient(world, worldName as WorldName, fingerprint, {
        onState: (state, id) => { if (current === generation) callbacks.onState(state, id); },
        onStatus: (info) => { if (current === generation) update(info); },
        onDisconnect: () => { if (current === generation) { connecting = false; callbacks.onDisconnect(); } },
      });
      callbacks.onConnecting();
      const url = new URL("/relay", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      client.connect(url.href, roomCode);
    } catch (error) {
      connecting = false;
      create.disabled = join.disabled = false;
      output.textContent = error instanceof Error ? error.message : "Could not connect.";
    }
  };
  create.addEventListener("click", () => { void connect(); });
  panel.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); void connect(code.value.trim().toUpperCase()); });
  leave.addEventListener("click", () => client?.disconnect());
  // Lobby text never becomes a driving, horn or firing input.
  panel.addEventListener("focusin", () => callbacks.onFocus());
  panel.addEventListener("keydown", (event) => event.stopPropagation());
  panel.addEventListener("keyup", (event) => event.stopPropagation());
  window.__fogcityNet = { info: () => client ? { ...client.info, players: { ...client.info.players } } : null,
    confirmed: () => client?.prediction.confirmed ?? null };
  return {
    active: () => connecting || client?.info.status === "connected" || client?.info.status === "recovering",
    sample: (input) => client?.sample(input),
  };
}
