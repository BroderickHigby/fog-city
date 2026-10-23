# Offline AI boundary

`createAiService()` defaults to scripted responses. No network provider, API client, key lookup, file persistence or console logging is shipped. An injected provider is used only when `enableProvider` is explicit and every enabled route and the safety classifier have a passing evaluation record matching its provider ID, model and prompt version. Those records are deployment configuration, never client input.

Host integration:

```ts
const ai = createAiService();
const handleAi = createAiHttpHandler(ai);
// In the host request handler, before its 404:
if (await handleAi(req, res)) return;
```

The host issues single-use invites using `ai.issueInvite()`. This method has no public HTTP route. `POST /api/ai/signup` accepts only `{ invite, adult, consent }` and returns an expiring signed account token. Authenticated `POST /api/ai/session` accepts only `{ feature }` and returns an account-bound signed conversation ID. Every feature route accepts only `{ sessionId, turn, text }` or `{ sessionId, turn, choiceId }`; use `Authorization: Bearer <account token>`.

Feature routes: `/api/ai/partner-interview`, `/api/ai/ai-02`, `/api/ai/explain-to-mom`, `/api/ai/customer-discovery`, `/api/ai/ai-08-vibes-night`, `/api/ai/trust-and-safety`. The three scripted choices are `specific`, `unknown` and `buzzwords`. Non-attested accounts can use those choices but cannot submit text to a provider.

Room roasts are a trusted host operation through `runRoomRoast`, supplied with an approved kit ID and the other player IDs to suppress. Public roast text submissions are rejected. The response separates enum/ID/integer event data from owner-only presentation text. The room host decides any vote or award; the provider cannot select a winner.

The HTTP adapter caps JSON bodies at 8 KiB, uses the socket peer address, sets no-store response headers and returns `false` for unrelated paths. The host must configure its normal HTTP timeouts and allowed origins. The service uses in-memory quotas and sessions; restart invalidates tokens. Horizontal deployment needs shared session/quota storage before enabling an external provider.

The service stores no transcript. Redacted input exists only while an in-flight provider request runs. Session metadata has a maximum lifetime of 24 hours; `endSession()` and expiry delete it. Duplicate or simultaneous turns share one result; timed-out or cancelled provider work cannot replace a terminal result. A crisis always returns the shared sincere resource response, even after a turn has already settled, without emitting a second gameplay event.

Draft PR title: Add offline AI session and validation boundary
Draft PR body: Adds fixed AI routes with signed invite-only sessions, strict DTOs, crisis and output gates, quota reservations, idempotent turns, timeout handling and an explicit offline fixture provider. Provider use defaults off and requires matching evaluation records. No external API client, credentials or deployment changes are included. The host mounts the exported HTTP adapter.

Validation: TypeScript and all 24 AI tests passed, including the real loopback HTTP adapter. Loopback binding required the test command to run outside the workspace network sandbox; no external network destination was used. The tests cover forged/cross-account sessions, closed DTOs, age and consent gates, evaluation requirements, duplicate/late results, crisis priority, output and echo rejection, quotas, metadata expiry, immutable results and request-size/IP handling.
