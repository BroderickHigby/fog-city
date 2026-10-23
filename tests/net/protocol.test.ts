import { describe, expect, it } from "vitest";
import { NET_VERSION, parseClientMessage } from "../../src/net/protocol.ts";
import { Action, SIM_VERSION } from "../../src/sim/index.ts";

const hello = { type: "create", version: NET_VERSION, simVersion: SIM_VERSION, world: "dev", fingerprint: "a".repeat(64) };
const input = { type: "input", seq: 1, input: { throttle: 1, steer: 0, brake: 0, actions: 0 } };
describe("closed relay protocol", () => {
  it("accepts only the current game/version and bounded control input", () => {
    expect(parseClientMessage(JSON.stringify(hello))).toEqual(hello);
    expect(parseClientMessage(JSON.stringify(input))).toEqual(input);
    const aimed={...input,input:{...input.input,actions:Action.cone|Action.gadget|Action.altFire,aimYaw:1.2,aimPitch:.4}};
    expect(parseClientMessage(JSON.stringify(aimed))).toEqual(aimed);
  });
  it.each([
    { ...hello, version: 99 }, { ...hello, simVersion: SIM_VERSION - 1 }, { ...hello, world: "../../private" },
    { ...hello, name: "unmoderated name" }, { ...hello, fingerprint: "different" },
    { type: "chat", text: "hello" }, { type: "state", state: { tick: 99 } },
    { ...input, playerId: "p2" }, { ...input, seq: -1 }, { ...input, seq: 1.5 },
    { ...input, input: { ...input.input, throttle: 2 } }, { ...input, input: { ...input.input, throttle: null } },
    { ...input, input: { ...input.input, brake: -1 } }, { ...input, input: { ...input.input, actions: 1<<29 } },
    { ...input, input: { ...input.input, aimYaw:null } }, { ...input, input: { ...input.input, aimPitch:"0" } },
    { ...input, input: { ...input.input, actions: 1.5 } }, { type: "resync", extra: true },
  ])("rejects incompatible or unauthorized payload %j", (message) => {
    expect(() => parseClientMessage(JSON.stringify(message))).toThrow();
  });
  it("rejects malformed, nonfinite, and oversized JSON", () => {
    for (const text of ["null", "[]", "{", '{"type":"input","seq":1,"input":{"throttle":1e999,"steer":0,"brake":0,"actions":0}}', "x".repeat(4097)]) {
      expect(() => parseClientMessage(text)).toThrow();
    }
  });
  it("accepts only identity-free closed gameplay commands",()=>{
    const command={type:"command",command:{sequence:0,kind:"mission-start",targetId:"hot-desk"}};
    expect(parseClientMessage(JSON.stringify(command))).toEqual(command);
    for(const extra of [{playerId:"p2"},{text:"arbitrary text"},{kind:"robot.heap"},{sequence:-1},{targetId:"__proto__"}]) {
      expect(()=>parseClientMessage(JSON.stringify({...command,command:{...command.command,...extra}}))).toThrow();
    }
  });
});
