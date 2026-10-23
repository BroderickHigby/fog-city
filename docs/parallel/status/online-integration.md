# Online service integration

Branch: `lane/online-integration/wave6`. Base: tested `lane/server-ai/wave6` at `a033b24`.

The private relay now mounts the fixed AI HTTP routes before its 404. Provider access remains disabled, invitation creation is a trusted host API, and no key, paid service or deployment is configured. The HTTP seam contains handler failures and bounds request/header times.

Validation: TypeScript and 25 tests passed, including real loopback service requests, size/type limits, authentication, eval gates, idempotency, crisis handling and relay error containment. No external API calls were used.

Draft PR title: `Online: mount the tested AI service on the private relay`

Draft PR body: Mounts the fixed, session-bound AI routes alongside the existing private relay. The default service uses scripted fallbacks with live providers disabled. Adds a bounded HTTP handler seam with error containment. TypeScript and 25 offline/loopback tests pass. Hosting and any live-provider configuration remain unconfigured.
