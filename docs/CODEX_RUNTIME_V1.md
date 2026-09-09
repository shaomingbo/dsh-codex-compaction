# Codex Runtime v1 — owner-bound capability contract

An inter-plugin contract, not a DSH core API. Accounts & Usage owns
`ctx.codexRuntime`; the compaction bundle consumes it through Cordis injection. No
caller receives OAuth values, a credential reference, arbitrary authenticated fetch
or access to another plugin's grant. Existing `openai-codex` routing/login remains
untouched.

## 0.3.3 consumer image replay repair

No owner contract or checkpoint version changes. Existing `provider({ mode: 'stream',
replay })` accepts Pi image content and expands native replay slots on the same bound
connection. The consumer now obtains projected image bytes using the public DSH
PiAiAdapter attachment callbacks. Its Basic mixed-image summarization uses that stream
with the full Basic instruction and a `purpose: 'compaction'` lease, returning readable
text instead of a native envelope. It is reported as `reader-text`, never as native
image compaction or recovery fallback. One request, no retry or stock fallback on
failure; the normal usage receipt passes through. The owner's v1 native compact
transport and checkpoint codec remain text-only and unchanged.

## 0.3.2 + 5.1.3 setup, total and idle budgets

The account composition selects **1800000ms total** for an ordinary `open` and
**120000ms setup** for metadata/account binding. The total deadline begins at open and
includes setup; setup is not a second full request budget. An open with
`purpose: 'compaction'` retains **300000ms total**, including setup, and does not receive a
separate shorter setup deadline. Provider creation, retry and fallback cannot renew a lease.

At the owner runtime factory, `timeoutMs` remains the ordinary total-budget option; explicit
short-call values retain their meaning. New `setupTimeoutMs` defaults to
`min(timeoutMs, 120000)`; `compactionTimeoutMs` defaults to `min(timeoutMs, 300000)`.
These factory settings are not added to the consumer-facing `open` arguments. The production
composition's ordinary total is 1800000ms; compaction remains bounded independently at 300000ms.

The companion uses the existing public DSH PiAiAdapter **300000ms idle watchdog** for both
ordinary replay/text and native compaction conversion. It adds no SSE monitor. This is a
stream-inactivity limit, not the owner's setup or total budget. Owner deadline failures keep
`CODEX_RUNTIME_TIMEOUT`; the Pi watchdog keeps **`TIMEOUT`** with a fixed idle-timeout
message, not an owner timeout category or arbitrary upstream diagnostic text.

The optional v1 diagnostic extension adds nonnegative safe integers `totalBudgetMs`,
`setupBudgetMs`, `timeoutBudgetMs` and strict `timeoutKind: 'setup' | 'total'`. Existing
`budgetMs` still means the actual selected **total** budget; `timeoutBudgetMs` identifies
the budget that expired, with `timeoutKind` distinguishing setup from total. Fields can be
absent (including setup fields on compaction). Unknown fields/enum values and invalid numbers
are not forwarded; bodies, credentials and arbitrary strings remain excluded.

Old owners/readers and absent optional fields remain compatible, but an older owner does not
acquire the new total budget merely by updating this consumer. The complete correction requires
**0.3.2 + 5.1.3 together**. Tag identity and tag-installation results are recorded in the
release; current-host acceptance is recorded separately. Neither publication nor live acceptance
is claimed complete here; the following evidence belongs to the historical pair only.

## Historical 0.3.1 + 5.1.2 Native-only compaction budget

The live-accepted pair uses `purpose: 'compaction'`, an optional extension selecting the
owner's separately bounded compaction lease. The account composition grants 300000ms;
ordinary opens remain 120000ms. Older owners ignoring purpose retain their prior deadline.
`budgetMs` in the optional diagnostics reports the actual selected lease budget. No caller
supplies an arbitrary duration, and creating providers/retrying/falling back cannot renew
the lease. Release-tag publication is separate from this acceptance; the maintainer has also
rerun the frozen production candidate's 498-test regression (see validation).

Only native `compactOnLease` uses the 300000ms pi-converter idle allowance, because the
native provider emits no pi output until completion. Ordinary replay/text converters stay
at 120000ms. The original owner lease remains authoritative over the entire recovery
sequence. The existing one-extra-request budget and 60-second failure suppression do not
change. The accepted 157372ms real run used one request with budget 300000ms and produced an
official history replacement; it does not establish a production latency SLA or fix all timeouts.

`operation.diagnostics()` exposes fixed enums/counts/timings only; its detached `eventCounts`
distinguish reasoning items, message items, compaction items and text/summary activity.
Unknown event names/types stay `other` (or fixed item-other categories), never raw strings.
Samples do not include ids, bodies, account data, credentials or opaque native state.

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
- `open({ model, signal, purpose? })` → authenticated operation handle below; the owner
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
- Optional `diagnostics()` returns a detached fixed-field snapshot: `version`, `phase`,
  `budgetMs`, `elapsedMs`, `metadataMs`, `boundMs`, `requestMs`, `headersMs`, `firstByteMs`,
  `lastByteMs`, `lastEventMs`, `itemMs`, `completedMs`, `httpStatus`, `requests`,
  `requestBytes`, `responseBytes`, `chunks`, `events`, `lastEvent` and `eventCounts`.
  The owner 5.1.3 extension optionally adds `totalBudgetMs`, `setupBudgetMs`,
  `timeoutBudgetMs` and `timeoutKind` (`setup` or `total`); `budgetMs` remains the total budget.
  Stage-specific fields may be absent. The consumer accepts only nonnegative safe integers
  for counts/timings and fixed owner-selected enums for phase/event/timeout kind. Request counts cover the lease; response counters cover
  the latest request. No raw event name, id, URL, body or credential is returned.
- `close()` cancels/releases the operation, idempotently; it freezes the diagnostic clock.

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

## 5.1.2 completion and failure correction

The protocol and checkpoint remain v1; optional purpose selection and diagnostics are described
above. The native owner finishes at the valid `response.completed` (or compatible `response.done`)
event with one compaction item, cancels/releases the reader and ignores subsequent bytes
regardless of chunk boundaries. Before completion, invalid/duplicate items, malformed complete
data and resource limits still fail. Premature EOF, including a truncated JSON/SSE/UTF-8 frame,
or failed socket read maps to recoverable `CODEX_RUNTIME_RESPONSE_STREAM`; malformed native
responses map to non-retryable `CODEX_RUNTIME_RESPONSE_PROTOCOL`.

The first lease stop cause remains TIMEOUT, CANCELLED, CLOSED or DISPOSED on subsequent
provider/auth/stream use. Neither a retry nor fallback resets the original owner deadline;
TIMEOUT does not allow fallback. The consumer alone owns its one shared recovery request,
so transport/SDK retries are not added underneath it. In-flight account identity remains fixed.
Old compatible runtime versions can still be used, but do not acquire these new completion
and error-classification guarantees merely by updating the compaction consumer.

The 0.3.1 consumer spends at most one extra request in the same lease/account/model/endpoint:
network/5xx/stream failures prefer a native retry after a cancellable 200ms delay; other
allowlisted availability failures may use text fallback. They cannot stack. Protocol/identity
errors, cancellation and expired leases do not trigger recovery; carrier histories never
fall back to text. This is plugin recovery policy, not official Codex Native-to-text fallback.
Terminal failures suppress new taken-over requests for 60 seconds per session/provider/model;
ordinary generation is not paused. Only matching official replacement and clean end clear
failure state. This bounded process-local state resets on restart.

Known non-blocking limitation: cancellation can display `CODEX_RUNTIME_ERROR` in compaction
status despite the owner's first-stop preservation. A refresh may cancel a pending manual
command; tab switching alone is not established as a cause. Neither these changes nor the
longer native budget promise uninterrupted progress at hard context limits.

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

This contract is verified offline by the unit, installer-isolation and paired
cross-plugin suites (fake auth/transport, synthetic data). A human-approved
controlled live budget additionally exercised the native path on the real
paired account runtime; the de-identified facts, results and their limits are
recorded in [docs/VALIDATION.md](VALIDATION.md). No real-account availability,
token, cost or latency claim follows from any of these suites.