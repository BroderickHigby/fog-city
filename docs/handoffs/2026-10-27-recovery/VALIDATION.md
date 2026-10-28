# Recovery validation

This file records fresh checks on the isolated recovered source. Historical evidence in adjacent files is labelled separately. No full browser, sustained-performance or1GB acceptance is implied by a typecheck or focused test pass.

## Fresh checks on the recovered source

| Check | Result | Duration |
| --- | --- | --- |
| `pnpm typecheck` | PASS, exit0 | 15.37s |
| Focused Vitest run with `--maxWorkers=1` | PASS:184 tests across26 files | 42.32s process;40.06s runner |

The exact command arguments, exit codes and times are in `evidence/fresh/results.json`. Raw output is in `typecheck.log` and `focused-tests.log` beside it. The checks ran serially using the original installed dependency versions, copied into the isolated recovery checkout. No production source changes were made after these checks.

Coverage includes consolidated integration/versioning, physical placement and combat recovery, pause timers, lures, weather speed, match authority/physical flowers, progression, Coit, Plain Words, Office Hours, parking, taxi routes/session, tactical effects, recorded audio/opening, loadout/graphics and saved progression. The selected tests are not a full suite, real-city route proof or browser acceptance.

## Packaging and provenance

- All116 captured pending files were copied byte-for-byte and checked against `RECOVERED_FILES.json`.
- The existing two remote documentation cleanups were preserved.
- Portable historical evidence is hashed in `EVIDENCE_MANIFEST.json`; reports retain their original scope and limitations.
- Whitespace inspection found pre-existing trailing blank lines in the recovered hostile-marker and junction-test source, plus whitespace in preserved historical patch context. These are retained to preserve the captured source/evidence; they are not functional test failures.

## Not run during recovery

Full Vitest, a new production/static build, browser/E2E, full mission/taxi routes, current-source traffic soaks, structural route/deck checks, audio listening approval, memory/performance and1GB capacity acceptance. These remain in `HANDOFF.md`.

No CI rerun, merge, deployment or old-PR closure was performed by the recovery.
