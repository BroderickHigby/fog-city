## Independent review (coordinator): blocked, recommend closing

PR #20 (`lane/modes-online/wave4`) already contains this PR's Server-Net code (f471347 and b788d11). It adds server-identified gameplay commands and a shared sim runner, stays on SIM_VERSION 6 and keeps to Lane 6's directories. Use #20 as the basis.

**Blockers here**
1. **71affdf merges `feature/dodge` and sets `SIM_VERSION = 5`.**
   - **Ownership:** that merge is Lane R's, per `docs/parallel/README.md`.
   - **Conflict:** `integrate/wave2` is already at 6, so this is a contract conflict that breaks saves and replays.
2. **88e2a20 edits other lanes' directories and the world-QA gate.**
   - **Directories:** `public/models/*.glb`, `assets/blender`, `content/landmarks.json`, `pipeline/lib`, `src/content` and `tests/golden`.
   - **Gate:** it changes the world-QA gate's helpers.
   - **Tests:** its own commit message says 2 tests fail.
   - **QA lanes:** the PR also brings in the QA lanes, which only Lane R may merge, and into `integrate/wave1`, not wave2.
3. **684c790 (high) edits other lanes' files and doesn't prove what it claims.**
   - **Ownership:** it edits `src/main.ts` and `vite.config.ts` (Lane R), `src/input/keyboard.ts` (Lane 7), and `tests/e2e` and `package.json` (Lane 2).
   - **Lobby panel:** the "Play with friends" panel ships in every build, including the static page, which has no relay.
   - **e2e never runs:** the two-browser test is `multiplayer.net.ts`, but `playwright.config.ts:31` only matches `*.spec.ts`. It never runs in CI.
4. **The netcode findings on #20 apply here too:**
   - the snapshot sent every second;
   - no per-IP caps;
   - the unbounded resync assertion;
   - the `hello` spread bug.

**Suggested path**
1. Close this PR.
2. Port `src/net/lobby.ts` and its test into Lane 6's branch.
3. File the `main.ts`, Vite, keyboard and e2e hooks as requests to their owner lanes.
4. Don't merge 71affdf or 88e2a20 anywhere through this PR.
