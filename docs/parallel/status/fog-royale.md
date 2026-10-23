# Fog Royale reducer

Branch: `lane/fog-royale/wave7`, based on modes checkpoint `7b79a73`.
Owned changes: standalone `src/sim/modes/royale.ts`, focused tests and this handoff.

## Runtime contract

`createRoyale(config)` creates separate match runway, score, recovery flags and seeded circles.
`stepRoyale(previous, context)` returns state, current circle, all live founder anchor IDs,
bot intents, duel requests and taxi redeploy requests. Parent mode integration can attach the
state as `MatchState.royale`; this branch does not edit shared match DTOs or scheduling.

- Five phases, each with a 90-second hold and 60-second close, interpolate nested circles
  toward a seeded final landmark supplied from the built-world catalog.
- Accepted positions determine fog exposure. Outside costs one month per three active
  seconds; a claimed fleece halves the rate for 60 seconds. Cloud-credit crates restore
  three months. Crate claims require actual proximity and pay only once.
- Confirmed bad-robot heaps restore one month and add 100 points. The provider must supply
  `badRobotIds`; unknown/friendly IDs never pay. Authoritative flower events add 150 points
  and reduce the target's runway, using tick + event ID replay cursors.
- First zero runway revives in place at six months. The second queues a duel with another
  exhausted founder for 20 seconds, then a bot associate. Only an authoritative winning duel
  result requests redeploy; core must confirm the matching taxi request and actual player
  pose at the current circle edge before six months are restored. Third zero eliminates.
- Solo allocates exactly seven rival-founder bot IDs. All founders are fidelity anchors.
  Bot movement/flower intents require the core physical follower and combat integration;
  this pure module does not simulate fake victories or claim a physical solo soak.
- All durations use `elapsedTicks`; global paused/skipped ticks do not consume timers.

## Validation

Focused tests cover phases, measured-position drain, fleece/crates, pause, invalid/missing
poses, one-time scoring, all recovery stages, real-pose redeploy acceptance, bot IDs/intents,
negative event ticks, pause suppression and deterministic stepping.

`pnpm exec vitest run tests/sim/modes/royale.test.ts tests/sim/forbidden-apis.test.ts --maxWorkers=2`
passed **57 tests** (10 Royale cases plus the repository deterministic-API scan).
`pnpm typecheck` passed. All heavy checks used `/tmp/fog.lock` and the 8 GB Node cap.
No full browser suite or physical bot soak is claimed here.

## Draft pull request

Title: `Modes: implement Fog Royale state, recovery and bot intents`

Base: `lane/modes-online/wave4`; head: `lane/fog-royale/wave7`.

Body: Implement the standalone deterministic Fog Royale reducer with five seeded fog phases,
position-driven runway loss, timed fleece and crate rewards, Bridge Round/duel/redeploy
recovery, replay-safe combat rewards and seven solo rival-founder intents. Keep match state
separate from free roam. Taxi redeployment and bot movement remain explicit requests for core
acceptance; parent mode wiring supplies physical results and recorded input.
