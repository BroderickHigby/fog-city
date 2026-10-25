// Headless relay load test: `pnpm relay:load [rooms...]` (default 1 2 3 4 6 8).
//
// Forks the real relay (relay-child.ts, its own process and event loop, as in production) on the
// SF world. For each room count it fills that many Bot Sweep rooms with four headless clients each
// (raw WebSockets that send 60 inputs a second and count the frames they receive, without stepping
// the sim themselves), runs them for LOAD_SECONDS (default 20), then reads the relay's /metrics:
// ticks run per second (60 = keeping up), the whole-tick time across all rooms, CPU and memory.
// Results go in server/README.md (Capacity).
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { NET_VERSION } from "../../src/net/protocol.ts";
import { SIM_VERSION } from "../../src/sim/contract.ts";
import { randomName } from "../../src/net/identity.ts";

const seconds = Number(process.env.LOAD_SECONDS ?? 20);
const levels = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const counts = levels.length ? levels : [1, 2, 3, 4, 6, 8];

const child = fork(fileURLToPath(new URL("./relay-child.ts", import.meta.url)), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const { port, fingerprint } = await new Promise<{ port: number; fingerprint: string }>((done) => child.once("message", (m) => done(m as { port: number; fingerprint: string })));
const url = `ws://127.0.0.1:${port}/relay`;

interface Bot { ws: WebSocket; seq: number; frames: number; code: string; host: boolean; started: boolean }
function connect(action: "create" | "join", code = ""): Promise<Bot> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(url), bot: Bot = { ws, seq: 0, frames: 0, code, host: action === "create", started: false };
    const device = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", net: NET_VERSION, sim: SIM_VERSION, world: "sf", fingerprint, action,
      ...(code ? { code } : {}), profile: { name: randomName(), look: 0 }, device })));
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as { type: string; code?: string; message?: string };
      if (m.type === "welcome") { bot.code = m.code!; done(bot); }
      else if (m.type === "frame") bot.frames++;
      else if (m.type === "snapshot") bot.started = true;
      else if (m.type === "error") fail(new Error(String(m.message)));
    });
    ws.on("error", fail);
  });
}
const send = (bot: Bot, value: unknown): void => { if (bot.ws.readyState === WebSocket.OPEN) bot.ws.send(JSON.stringify(value)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function metrics(): Promise<Record<string, number>> {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text(), out: Record<string, number> = {};
  for (const [, name, value] of text.matchAll(/^fogcity_relay_([a-z0-9_]+) ([0-9.e+-]+)$/gm)) out[name!] = Number(value);
  return out;
}

const results: string[] = [];
for (const rooms of counts) {
  const bots: Bot[] = [];
  for (let r = 0; r < rooms; r++) {
    const host = await connect("create"); bots.push(host);
    for (let i = 0; i < 3; i++) bots.push(await connect("join", host.code));
  }
  await sleep(300);
  for (const bot of bots) send(bot, { type: "ready", ready: true });
  await sleep(300);
  for (const bot of bots) if (bot.host) send(bot, { type: "start", mode: "botSweep" });
  while (!bots.every((b) => b.started)) await sleep(50);
  await sleep(2000); // let the loop-time window fill with this level only
  for (const bot of bots) bot.frames = 0;
  const before = await metrics(), wall = performance.now();
  // Every client drives at 60 Hz with a little steering and the odd water shot, like a player.
  const timer = setInterval(() => {
    for (const bot of bots) send(bot, { type: "input", seq: ++bot.seq, input: { throttle: .6, steer: Math.sin(bot.seq / 40) * .5, brake: 0, actions: bot.seq % 90 === 0 ? 2 : 0 } });
  }, 1000 / 60);
  await sleep(seconds * 1000);
  clearInterval(timer);
  const after = await metrics(), elapsed = (performance.now() - wall) / 1000;
  const rate = (after.ticks_total! - before.ticks_total!) / elapsed;
  const cpu = ((after.cpu_seconds_total! - before.cpu_seconds_total!) / elapsed) * 100;
  const slowest = Math.min(...bots.map((b) => b.frames)) / elapsed;
  const line = `| ${rooms} | ${rooms * 4} | ${rate.toFixed(1)} | ${after.loop_ms_p50} | ${after.loop_ms_p99} | ${after.tick_ms_p50} | ${cpu.toFixed(0)}% | ${Math.round(after.memory_rss_bytes! / 1e6)} MB | ${slowest.toFixed(1)} |`;
  console.log(line); results.push(line);
  for (const bot of bots) { send(bot, { type: "leave" }); bot.ws.close(); }
  while ((await metrics()).seated_players) await sleep(200);
}
console.log("\n| Rooms | Players | Relay ticks/s | Loop p50 ms | Loop p99 ms | Room tick p50 ms | Relay CPU (one core = 100%) | RSS | Slowest client frames/s |");
console.log("|---|---|---|---|---|---|---|---|---|");
console.log(results.join("\n"));
child.disconnect();
process.exit(0);
