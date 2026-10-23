// The relay accepts controls, never client positions or arbitrary simulation events.
import { Action, SIM_VERSION, type InputFrame, type SimEvent, type SimInput, type SimState } from "../sim/index.ts";
import { gameplayCommandFromEvent, type GameplayCommand } from "../sim/gameplay-contract.ts";

export const NET_VERSION = 1;
export const MAX_PLAYERS = 4;
export const MAX_PREDICTION_TICKS = 8;
export const ROOM_LIFETIME_MS = 30 * 60_000;
export const MAX_MESSAGE_BYTES = 4096;
export const WORLDS = ["dev", "dev-city", "sf"] as const;
export type WorldName = (typeof WORLDS)[number];
export const NAME_PARTS = ["Misty Otter", "Sunny Finch", "Quiet Fox", "Silver Gull"] as const;

export interface Hello {
  type: "create" | "join";
  version: number;
  simVersion: number;
  world: WorldName;
  fingerprint: string;
  code?: string;
}
export type NetworkCommand=Omit<GameplayCommand,"playerId">;
export type ClientMessage = Hello | { type: "input"; seq: number; input: SimInput } | { type: "command"; command:NetworkCommand } | { type: "resync" };
export interface Snapshot {
  state: SimState;
  hash: string;
  ack: Record<string, number>;
  players: Record<string, string>;
}
export interface Frame {
  type: "frame";
  tick: number;
  inputs: InputFrame;
  events: SimEvent[];
  ack: Record<string, number>;
  players: Record<string, string>;
  hash?: string;
}
export type ServerMessage =
  | ({ type: "welcome"; version: number; simVersion: number; world: WorldName; fingerprint: string; code: string; playerId: string; expiresAt: number } & Snapshot)
  | ({ type: "snapshot" } & Snapshot)
  | Frame
  | { type: "error"; code: string; message: string };

const actionMask = Object.values(Action).reduce((mask, value) => mask | value, 0);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: string[]): boolean => Object.keys(x).length === names.length && Object.keys(x).every((k) => names.includes(k));
const between = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;

export function validInput(x: unknown): x is SimInput {
  return object(x) && ["throttle", "steer", "brake", "actions"].every(key=>Object.hasOwn(x,key)) &&
    Object.keys(x).every(key=>["throttle","steer","brake","actions","aimYaw","aimPitch"].includes(key)) &&
    between(x.throttle, -1, 1) && between(x.steer, -1, 1) && between(x.brake, 0, 1) &&
    between(x.actions, 0, actionMask) && Number.isInteger(x.actions) && (x.actions & ~actionMask) === 0 &&
    (!Object.hasOwn(x,"aimYaw") || typeof x.aimYaw==="number" && Number.isFinite(x.aimYaw)) &&
    (!Object.hasOwn(x,"aimPitch") || typeof x.aimPitch==="number" && Number.isFinite(x.aimPitch));
}

/** Closed message shapes also reject player-id spoofing, chat, and state injection. */
export function parseClientMessage(text: string): ClientMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_message"); }
  if (!object(value)) throw new Error("invalid_message");
  if(value.type==="command" && keys(value,["type","command"]) && object(value.command)) {
    const parsed=gameplayCommandFromEvent({tick:1,kind:"gameplay.command",playerId:"network",payload:value.command});
    if(parsed){const {playerId:_,...command}=parsed;return {type:"command",command};}
  }
  if (value.type === "resync" && keys(value, ["type"])) return { type: "resync" };
  if (value.type === "input" && keys(value, ["type", "seq", "input"]) &&
      between(value.seq, 1, 0x7fffffff) && Number.isInteger(value.seq) && validInput(value.input)) {
    return value as unknown as ClientMessage;
  }
  if ((value.type === "create" || value.type === "join") &&
      keys(value, value.type === "create" ? ["type", "version", "simVersion", "world", "fingerprint"] : ["type", "version", "simVersion", "world", "fingerprint", "code"]) &&
      value.version === NET_VERSION && value.simVersion === SIM_VERSION && WORLDS.includes(value.world as WorldName) &&
      typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint) &&
      (value.type === "create" || (typeof value.code === "string" && /^[A-Z2-9]{10}$/.test(value.code)))) {
    return value as unknown as Hello;
  }
  throw new Error("invalid_message");
}
