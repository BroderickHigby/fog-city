# Online service integration

Branch: `lane/online-integration/wave6`. Base: tested `lane/server-ai/wave6` at `a033b24`.

The private relay now mounts the fixed AI HTTP routes before its 404. Provider access remains disabled, invitation creation is a trusted host API, and no key, paid service or deployment is configured. The HTTP seam contains handler failures and bounds request/header times.

Validation: TypeScript and all 66 network/service tests pass on the combined branch, including real loopback requests, 180 ticks of the actual gameplay composition with matching client/server hashes, two minutes of jitter/corrupt-snapshot transport recovery, authentication, eval gates and relay error containment. The long transport stress fixture intentionally uses the base simulation; the shorter parity check uses the actual composed game. No external API calls were used.

The relay and prediction now default to the same composed game systems. Server world loading includes authored gameplay, sidewalk and transit data. The world fingerprint includes those inputs, so clients with different gameplay metadata cannot silently join the same room. Network commands start at sequence 1, matching the authoritative command reducer.

Draft PR title: `Online: run matching gameplay and world data on the relay and prediction`

Draft PR body: Runs the same composed game systems on the private relay and client prediction, loads authored gameplay/navigation/transit layers on the server, and fingerprints all deterministic world inputs. Mounts the fixed, session-bound AI routes with scripted fallbacks and live providers disabled. All 66 offline/loopback tests pass, including actual gameplay hash parity and delayed-input transport recovery. Hosting and live-provider configuration remain unconfigured.
