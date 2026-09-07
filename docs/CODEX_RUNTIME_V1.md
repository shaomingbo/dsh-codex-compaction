# Codex Runtime v1 — owner-bound capability contract

An inter-plugin contract, not a DSH core API. Accounts & Usage owns
`ctx.codexRuntime`; the compaction bundle consumes it through Cordis injection. No
caller receives OAuth values, a credential reference, arbitrary authenticated fetch
or access to another plugin's grant. Existing `openai-codex` routing/login remains
untouched.

## Host capability

- `protocol: 'codex-runtime/v1'`
- `describe()` → secret-free `{ protocol, route: 'codex-native-lab', configured,
  authOwner: 'dsh-token-usage', ...capabilities }`; no network.
- `models()` → detached pinned pi-ai Codex model descriptors, no
  credentials/secret headers. A catalog model is never guessed.
- **Trusted model resolution per `open`:** custom model ids (e.g. `gpt-6-astra`)
  resolve through the owner's `createCodexModelFacts` seam, which reads only
  whitelisted public host-configured profile fields
  (`id`/`name`/`contextWindow`/`maxTokens`/`input`/`reasoningEfforts`) and
  cross-checks the host-resolved model info. Conflicts and invalid values are
  fixed-vocabulary gaps (`METADATA_CONFLICT`, `PROFILE_INVALID`, …); an id absent
  from both the pinned catalog and the configuration is `UNKNOWN_MODEL`. Values are
  never invented, and URLs/headers/credentials never cross this seam. Resolution
  runs inside the operation's cancellation and deadline scope.
- **`applicability({ provider, model, signal })`** → metadata-only standard-route
  verdict `{ applicable, model? }` or `{ applicable: false, reason }` with fixed
  reason codes (`PROVIDER`, `ROUTE_*`, `NOT_CONFIGURED`, `UNKNOWN_MODEL`,
  `MODEL_METADATA`). Bounded by the runtime deadline, caller cancellation and
  disposal; it never resolves authentication, performs network I/O or leaks
  configured values.
- `open({ model, signal })` → authenticated operation handle below; the owner
  resolves/refreshes its existing ChatGPT connection once. Missing login fails with
  guidance to the existing Accounts & Usage UI. No login is initiated automatically.
- `encodeCheckpoint(record)`, `decodeCheckpoint(text, expected?)`,
  `validateCheckpoint(record, expected?)`: owner-defined pure JSON codec,
  preserving unknown item fields and rejecting unsupported versions/bindings.
  Source provenance is checked by the DSH bridge before these functions.
- `estimateCheckpoint(record)` → `{ tokens, basis, exact: false }`, a pure disclosed
  native replay estimate. It is not a fee or token oracle.
- `dispose()` cancels outstanding operation handles and pending metadata scopes; no
  credential mutation.

## Operation handle

- `binding`: immutable `{ provider: 'codex-native-lab', model, identity }`. Identity
  is a nonsecret account fingerprint; the v1 identity salt is preserved so moving
  code ownership alone does not change record identity.
- `provider({ mode: 'stream' | 'compact', replay: [{ placeholder, checkpoint }] })`
  → a pi-ai Provider over the already-bound connection. Only metadata and callable
  execution cross this seam; its public auth branch returns an empty resolved auth
  object while the actual bearer stays inside the stream implementation. The
  provider's `getModels()` returns the immutable bound model (including
  resolver-materialized custom models), not a filtered global catalog.
- `compactionUsage()` returns a detached `{kind:'observed',usage}` only for valid
  upstream native usage after drain, or `{kind:'unavailable'}` — never the SDK's
  default zero-filled usage. Field presence is preserved; same-handle concurrent
  execution is forbidden.
- `close()` cancels/releases the operation, idempotently.

The provider owns native message/tool conversion, exact placeholder expansion, the
fixed endpoint, attribution/header forwarding rules, Codex V2 compact and normal
SSE, and native text encoding for the transient converter result.

The DSH bridge owns generic Harness→Pi conversion through public PiAiAdapter, typed
compact-source validation, generation of unpredictable placeholders, and the
isolated legacy route registration. It does not implement OAuth, HTTP endpoint
selection or native model discovery.

Caller-supplied model objects, fetch functions, auth headers or response hooks must
not be able to redirect or extract the owner's credential. Resolve the bound model
from the owner's trusted facts or pinned catalog; allowlist streaming options;
force the fixed Codex origin and non-redirecting SSE. Validate every replay
checkpoint against the immutable binding before transport; consume each
placeholder exactly once. Never silently degrade malformed native state.

## Records and lifetime

Native record v1 remains `{version:1, protocol:'responses.compaction-trigger.v2',
provider, model, identity, items}`.

- **Standard path (official basic):** the persisted carrier is the owner codec's
  **versioned V1 text envelope** (`<dsh-codex-compaction-v1>…</…>`), committed by
  official basic as an ordinary compact-checkpoint message. Detection is
  prefix-strict; detection and validation are separate, so damaged or future
  payloads fail closed rather than becoming ordinary text. Semantic recall is
  lossy — the summary replays, the original conversation does not.
- **Legacy structured path:** pre-existing B sessions keep the standard DSH
  compact source plus `nativeCodex: record`; both readers stay and old logs are
  never rewritten. The provider can decode a valid old A text envelope for trusted
  histories; this does not migrate the old separate alpha grant.

Account changes may affect the next operation, not a request already pinned to a
connection. Token/header account disagreement from a racing owner auth resolution
must fail before I/O. In-flight operation deadlines and disposal stay
authoritative. No task data or credentials enter provider-account diagnostics.

The account repository's existing pi-ai 0.82.1 auth runtime is not upgraded as part
of this work. The separate pinned 0.84.4 alias serves only the native protocol
module; it does not create a second login or refresh owner. Unified SDK upgrades are
a separate validation task.

## Verification posture

This contract is currently verified **offline only** (unit, installer-isolation and
paired cross-plugin suites with fake auth/transport and synthetic data). Live
`gpt-6-astra`/`gpt-5.6-sol` native runs remain parent-gated acceptance and are not
yet verified.