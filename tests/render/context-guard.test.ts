// WebGL context loss handling (src/render/context-guard.ts) on a stand-in canvas and clock.
import { describe, expect, it } from "vitest";
import { ContextGuard, REPEAT_WINDOW_MS, RESTORE_TIMEOUT_MS, type GuardClock } from "../../src/render/context-guard.ts";

function fakeClock(): GuardClock & { t: number; advance(ms: number): void } {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const c = {
    t: 0,
    now: () => c.t,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: c.t + ms, fn, id: ++id }); return id; },
    clearTimeout: (h: unknown) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) { c.t += ms; for (const x of timers.splice(0).sort((a, b) => a.at - b.at)) { if (x.at <= c.t) x.fn(); else timers.push(x); } },
  };
  return c;
}

function setup(): { target: EventTarget; clock: ReturnType<typeof fakeClock>; log: string[]; guard: ContextGuard } {
  const target = new EventTarget();
  const clock = fakeClock();
  const log: string[] = [];
  const guard = new ContextGuard(target, { onLost: () => log.push("lost"), onRestored: () => log.push("restored"), onGiveUp: (r) => log.push(`giveup:${r}`) }, clock);
  return { target, clock, log, guard };
}
const lose = (t: EventTarget): Event => { const e = new Event("webglcontextlost", { cancelable: true }); t.dispatchEvent(e); return e; };
const restore = (t: EventTarget): void => { t.dispatchEvent(new Event("webglcontextrestored")); };

describe("ContextGuard", () => {
  it("asks the browser to restore the context, pauses drawing, and resumes on restore", () => {
    const { target, clock, log, guard } = setup();
    const e = lose(target);
    expect(e.defaultPrevented).toBe(true);
    expect(guard.contextLost).toBe(true);
    clock.advance(1000);
    restore(target);
    expect(guard.contextLost).toBe(false);
    clock.advance(RESTORE_TIMEOUT_MS * 2);
    expect(log).toEqual(["lost", "restored"]);
  });

  it("gives up when the context does not come back in time", () => {
    const { target, clock, log, guard } = setup();
    lose(target);
    clock.advance(RESTORE_TIMEOUT_MS + 1);
    expect(log).toEqual(["lost", "giveup:timeout"]);
    expect(guard.contextLost).toBe(true);
    restore(target); // too late: stays given up
    expect(log).toEqual(["lost", "giveup:timeout"]);
  });

  it("gives up on a second loss within the repeat window, but not after it", () => {
    const a = setup();
    lose(a.target); a.clock.advance(500); restore(a.target);
    a.clock.advance(REPEAT_WINDOW_MS / 2);
    lose(a.target);
    expect(a.log).toEqual(["lost", "restored", "lost", "giveup:repeated"]);
    const b = setup();
    lose(b.target); b.clock.advance(500); restore(b.target);
    b.clock.advance(REPEAT_WINDOW_MS + 1);
    lose(b.target);
    expect(b.log).toEqual(["lost", "restored", "lost"]);
    b.guard.dispose();
  });
});
