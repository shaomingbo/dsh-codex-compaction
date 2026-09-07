# Project constraints

- This is an experimental plugin, not a DSH fork. Never edit DSH core or install private-path imports/monkey patches.
- Target only published DSH 0.1.2-rc.1 and pinned pi-ai 0.84.4. Separate tested library composition from live GUI verification.
- Do not touch the running DSH process, real profiles, settings, credentials or sessions in tests. Use temporary storage and injected fake transport/auth.
- No staging, commits, tag creation, GitHub publication, catalog approval or live installation without explicit authorization.
- Run `npm run check`, `npm pack --dry-run --ignore-scripts`, `git diff --check` before claiming local completion. Existing tests are Node.js node:test, no lifecycle install scripts.
- Preserve upstream license notices when copying code. Native protocol references are documented; new code is independently implemented.
- The approved production direction is the official-basic integration: the stock BasicCompactionEngine stays primary (its purpose=compaction llm/stream hook), native runs through the account-owned codex-runtime/v1 seam, and official basic commits the owner codec's versioned V1 text envelope. Standard openai-codex sessions opt in per session (`/codex-native`, profile default off, restart-safe through public command events only). At most one transparent text fallback per native failure, inside the same owner lease/account. Structured B (codex-native-lab route/preset) and the archived A baseline remain legacy compatibility/readers; native compression stays manual-only there. Unknown versions/identity/protocol and malformed replay fail closed; enforce honest shrinking through provider-disclosed estimates and correct usage anchors, never fabricated usage.
- Authentication, native HTTP, codec and model catalog belong to the existing account owner's codex-runtime/v1 Module. Production compaction code must not import a native SDK, create a credential store/login flow or receive OAuth values.
- The account workspace's node_modules may link to the live Web profile. Never install dependencies there; use scripts/account-snapshot.js and the explicit isolated paired-checkout suite.
- The candidate GitHub repository/tag in metadata is NOT an existing published artifact; catalog candidate must remain blocked until real release identity and human approval exist.
