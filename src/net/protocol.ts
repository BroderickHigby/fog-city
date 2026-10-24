// The relay wire protocol. Clients send controls and lobby choices, never positions, state or
// free text; every message has a closed shape and is size-capped before parsing.
import { Action, SIM_VERSION, type InputFrame, type SimEvent, type SimInput, type SimState } from "../sim/index.ts";
import { gameplayCommandFromEvent, type GameplayCommand } from "../sim/gameplay-contract.ts";
import type { MatchPayoutEvent } from "../sim/modes/session.ts";
import type { MatchResult } from "../sim/modes/types.ts";

/** Bump on any wire-format change; a client and relay that differ refuse each other. */
export const NET_VERSION = 4;
export const MAX_PLAYERS = 4;
/** Client prediction never runs further ahead of the confirmed state than this (133 ms). */
export const MAX_PREDICTION_TICKS = 8;
export const MAX_MESSAGE_BYTES = 4096;
export const WORLDS = ["dev", "dev-city", "sf"] as const;
export type WorldName = (typeof WORLDS)[number];
export const MODES = ["botSweep", "cleanStreets"] as const;
export type NetModeId = (typeof MODES)[number];
/** Generated display names: the only names a peer ever sees (never free text). */
export const NAME_PARTS = ["Misty Otter", "Sunny Finch", "Quiet Fox", "Silver Gull"] as const;
export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TOKEN = /^[a-f0-9]{32}$/;

export interface Hello {
  type: "hello";
  net: number;
  sim: number;
  world: WorldName;
  fingerprint: string;
  /** create: a private room; quick: join (or open) a public room; join/rejoin: by code. */
  action: "create" | "quick" | "join" | "rejoin";
  code?: string;
  token?: string;
}
export type NetworkCommand = Omit<GameplayCommand, "playerId">;
export type ClientMessage =
  | Hello
  | { type: "ready"; ready: boolean }
  /** Host: bot teammates for the match (0–3; people always take precedence for seats). */
  | { type: "bots"; count: number }
  | { type: "start"; mode: NetModeId }
  /** Host, in the lobby: which mode the room will play. */
  | { type: "mode"; mode: NetModeId }
  | { type: "end" }
  | { type: "leave" }
  | { type: "input"; seq: number; input: SimInput }
  | { type: "command"; command: NetworkCommand }
  /** "mismatch": this client's hash differed from the relay's; "behind": it fell too far behind to catch up. */
  | { type: "resync"; tick: number; reason: "mismatch" | "behind" }
  | { type: "ping"; t: number };

export interface Member { id: string; name: string; ready: boolean; connected: boolean; host: boolean }
export type RoomPhase = "lobby" | "match" | "results";
export type Visibility = "private" | "public";
/** One public room in GET /rooms. Private rooms are never listed. */
export interface RoomListing { code: string; mode: NetModeId; phase: RoomPhase; players: number; bots: number; max: number; world: WorldName }
export interface RoomList { online: number; rooms: RoomListing[] }
export interface Snapshot { state: SimState; hash: string; ack: number }
export interface Frame {
  type: "frame";
  tick: number;
  inputs: InputFrame;
  events: SimEvent[];
  /** The receiving player's last input sequence the relay has applied. */
  ack: number;
  /** The relay's state hash after this tick; present once a second. */
  hash?: string;
}
export interface Results { matchId: string; result: MatchResult; payouts: MatchPayoutEvent[] }
export type ServerMessage =
  | { type: "welcome"; net: number; sim: number; code: string; playerId: string; token: string; expiresAt: number }
  | { type: "room"; phase: RoomPhase; mode: NetModeId; members: Member[]; matchId: string; visibility: Visibility; bots: number }
  | ({ type: "snapshot"; matchId: string; reason: "start" | "rejoin" | "mismatch" | "behind" } & Snapshot)
  | Frame
  | ({ type: "results" } & Results)
  | { type: "pong"; t: number }
  | { type: "error"; code: ErrorCode; message: string };

export const ERRORS = {
  invalid_message: "Unsupported message.",
  version_mismatch: "This multiplayer server runs a different game version. Refresh the page to update.",
  world_mismatch: "Your game world differs from the server's. Refresh to the same build.",
  world_unavailable: "That city is not available on this server.",
  room_missing: "Room not found. Check the code or create a new room.",
  room_expired: "This room has closed. Create a new room.",
  room_full: "This room already has four players.",
  room_started: "This match has already started. Ask for a new room.",
  seat_missing: "Your seat in that room has gone. Join again with the code.",
  server_full: "The server is full. Try again later.",
  too_many_connections: "Too many connections from your network. Close other tabs and try again.",
  too_many_rooms: "Too many rooms from your network. Finish one first.",
  rate_limit: "Too many messages. Rejoin after a moment.",
  not_host: "Only the host can do that.",
  not_ready: "Everyone must be ready first.",
  arena_unavailable: "The arena could not be built. Try again.",
  input_sequence: "Input sequence was invalid. Rejoin the room.",
  idle: "Disconnected for inactivity.",
  slow_client: "Your connection fell behind. Rejoin the room.",
  replaced: "This seat was opened in another tab.",
} as const;
export type ErrorCode = keyof typeof ERRORS;

let actionMask = 0;
for (const key of Object.keys(Action) as (keyof typeof Action)[]) actionMask |= Action[key];
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(x).length === names.length && Object.keys(x).every((k) => names.includes(k));
const between = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const integer = (x: unknown, min: number, max: number): x is number => between(x, min, max) && Number.isInteger(x);

export function validInput(x: unknown): x is SimInput {
  return object(x) && ["throttle", "steer", "brake", "actions"].every((key) => Object.hasOwn(x, key)) &&
    Object.keys(x).every((key) => ["throttle", "steer", "brake", "actions", "aimYaw", "aimPitch"].includes(key)) &&
    between(x.throttle, -1, 1) && between(x.steer, -1, 1) && between(x.brake, 0, 1) &&
    integer(x.actions, 0, actionMask) && (x.actions & ~actionMask) === 0 &&
    (!Object.hasOwn(x, "aimYaw") || between(x.aimYaw, -100, 100)) &&
    (!Object.hasOwn(x, "aimPitch") || between(x.aimPitch, -100, 100));
}

/** Parse one client message. Throws Error("invalid_message" | "version_mismatch"). */
export function parseClientMessage(text: string): ClientMessage {
  if (text.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) throw new Error("invalid_message");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_message"); }
  if (!object(value)) throw new Error("invalid_message");
  switch (value.type) {
    case "input":
      if (keys(value, ["type", "seq", "input"]) && integer(value.seq, 1, 0x7fffffff) && validInput(value.input)) return { type: "input", seq: value.seq, input: { ...value.input } };
      break;
    case "bots":
      if (keys(value, ["type", "count"]) && integer(value.count, 0, MAX_PLAYERS - 1)) return { type: "bots", count: value.count };
      break;
    case "ready":
      if (keys(value, ["type", "ready"]) && typeof value.ready === "boolean") return { type: "ready", ready: value.ready };
      break;
    case "start": case "mode":
      if (keys(value, ["type", "mode"]) && MODES.includes(value.mode as NetModeId)) return { type: value.type, mode: value.mode as NetModeId };
      break;
    case "end": case "leave":
      if (keys(value, ["type"])) return { type: value.type };
      break;
    case "resync":
      if (keys(value, ["type", "tick", "reason"]) && integer(value.tick, 0, 0x7fffffff) && (value.reason === "mismatch" || value.reason === "behind")) return { type: "resync", tick: value.tick, reason: value.reason };
      break;
    case "ping":
      if (keys(value, ["type", "t"]) && between(value.t, 0, Number.MAX_SAFE_INTEGER)) return { type: "ping", t: value.t };
      break;
    case "command":
      if (keys(value, ["type", "command"]) && object(value.command)) {
        const parsed = gameplayCommandFromEvent({ tick: 1, kind: "gameplay.command", playerId: "network", payload: value.command });
        if (parsed) { const { playerId: _, ...command } = parsed; return { type: "command", command }; }
      }
      break;
    case "hello": {
      const action = value.action;
      const shape = action === "create" || action === "quick" ? ["type", "net", "sim", "world", "fingerprint", "action"]
        : action === "join" ? ["type", "net", "sim", "world", "fingerprint", "action", "code"]
        : action === "rejoin" ? ["type", "net", "sim", "world", "fingerprint", "action", "code", "token"] : null;
      if (!shape || !keys(value, shape)) break;
      // Version first, so an old client hears why it was refused.
      if (value.net !== NET_VERSION || value.sim !== SIM_VERSION) throw new Error("version_mismatch");
      if (!WORLDS.includes(value.world as WorldName) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{8,64}$/.test(value.fingerprint)) break;
      if ((action === "join" || action === "rejoin") && (typeof value.code !== "string" || !ROOM_CODE.test(value.code))) break;
      if (action === "rejoin" && (typeof value.token !== "string" || !TOKEN.test(value.token))) break;
      return value as unknown as Hello;
    }
  }
  throw new Error("invalid_message");
}
