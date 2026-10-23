# Online service integration

Branch: `lane/online-integration/wave6`. Base: tested `lane/server-ai/wave6` at `a033b24`.

The private relay now mounts the fixed AI HTTP routes before its 404. Provider access remains disabled, invitation creation is a trusted host API, and no key, paid service or deployment is configured. The HTTP seam contains handler failures and bounds request/header times.

Validation: TypeScript and all 66 network/service tests pass on the combined branch, including real loopback requests, 180 ticks of the actual gameplay composition with matching client/server hashes, two minutes of jitter/corrupt-snapshot transport recovery, authentication, eval gates and relay error containment. The long transport stress fixture intentionally uses the base simulation; the shorter parity check uses the actual composed game. No external API calls were used.

The relay and prediction now default to the same composed game systems. Server world loading includes authored gameplay, sidewalk and transit data. The world fingerprint includes those inputs, so clients with different gameplay metadata cannot silently join the same room. Network commands start at sequence 1, matching the authoritative command reducer.

The tested core performance checkpoint `f9ca263` is now included. After this merge, 84 checks across actual gameplay parity, world fingerprints and simulation purity pass. The earlier full set of 66 loopback/network/service tests remains recorded above; hosting and an in-game network lobby are still outside this branch.

Draft PR title: `Online: run matching gameplay and world data on the relay and prediction`

Draft PR body: Runs the same composed game systems on the private relay and client prediction, loads authored gameplay/navigation/transit layers on the server, and fingerprints all deterministic world inputs. Mounts the fixed, session-bound AI routes with scripted fallbacks and live providers disabled. All 66 offline/loopback tests pass, including actual gameplay hash parity and delayed-input transport recovery. Hosting and live-provider configuration remain unconfigured.
## Service admission repair intake

The online branch includes `5e8bf5b` as `47a83c6`: full service-vehicle hull checks, player foot/car blockers, shared pending-spawn clearance and safe deferred retries. The same repaired planner runs in authoritative relay and client prediction. Later threat dispatch, flight and Tidy features are not included.

Validation after intake: TypeScript and **7 files / 19 tests** pass, covering service/transit admission, physical van/bus behavior, actual gameplay composition parity, authenticated gameplay-driver parity and deterministic world fingerprints. The earlier full network/service and transport-stress results remain separate evidence.

Final convergence intake: `c9b4b98` aligns legacy taxi admission with the drawn `ROBOTAXI_BODY`; `bc30b99` sweeps runtime walkers against every vehicle hull; `50e57fd` settles activity rewards before publishing completion. Both relay and prediction retain the shared gameplay factory.

Final branch validation: TypeScript and **6 files / 16 tests** pass for reward ordering, gameplay/driver parity, world fingerprints, runtime walker clearance and service admission. The earlier pre-order contact batch passed 24 focused tests. This wave-2 branch lacks the later checkpoint producer and save host: its regression supplies one current-tick accepted completion fact at tick 61, checks the immediate 207500-cent wallet and 100 XP, and rejects duplicate payment over 120 more ticks. Save/restore coverage remains in the combined build; no later activity or UI modules were imported.
