// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
import { createHash } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { credentialKey, AuthorizationDeclinedError } from './compatibility.js';
import { PLUGIN, NATIVE_PROVIDER, failure } from './constants.js';

export const AUTH_KEY = credentialKey(PLUGIN, 'codex');
export const NO_AMBIENT_AUTH = Object.freeze({ env: async () => undefined, fileExists: async () => false });
const checkAbort = options => options?.signal?.throwIfAborted();
function unpack(record) {
  if (record === undefined) return undefined;
  const c = record?.payload?.credential;
  if (record.kind !== 'grant' || record.payload?.version !== 1 || c?.type !== 'oauth' ||
      typeof c.access !== 'string' || !c.access || typeof c.refresh !== 'string' || !c.refresh ||
      !Number.isFinite(c.expires)) throw failure('CODEX_LAB_INVALID_AUTH', 'The plugin-owned Codex authorization record is invalid; sign in again.');
  return structuredClone(c);
}
function own(provider) {
  if (provider !== NATIVE_PROVIDER) throw failure('CODEX_LAB_AUTH_SCOPE', 'Credential access outside the plugin-owned Codex route is forbidden.');
}
/** Only this plugin's own versioned record is interpreted. Never inspect another owner's grant. */
export function createCredentialStore(credentials) {
  return {
    async read(provider, options) { own(provider); checkAbort(options); return unpack(await credentials.readRecord(AUTH_KEY)); },
    async list(options) { checkAbort(options); return (await credentials.describeRecord(AUTH_KEY)).configured ? [{ providerId: NATIVE_PROVIDER, type: 'oauth' }] : []; },
    async modify(provider, mutate, options) {
      own(provider); checkAbort(options);
      const record = await credentials.modifyRecord(AUTH_KEY, async current => {
        checkAbort(options);
        const next = await mutate(unpack(current));
        checkAbort(options);
        if (next === undefined) return undefined;
        const updated = { kind: 'grant', payload: { version: 1, credential: structuredClone(next) } };
        unpack(updated);
        return updated;
      });
      return unpack(record);
    },
    async delete(provider, options) { own(provider); checkAbort(options); await credentials.deleteRecord(AUTH_KEY); },
  };
}

/** Derive a non-secret compatibility fingerprint; never expose the raw account identifier. */
export function tokenIdentity(accessToken) {
  try {
    if (typeof accessToken !== 'string' || accessToken.length > 64 * 1024) throw new Error();
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof accountId !== 'string' || !accountId || /[\r\n]/.test(accountId)) throw new Error();
    return { accountId, identity: createHash('sha256').update(`${PLUGIN}/identity/v1\0${accountId}`).digest('hex') };
  } catch { throw failure('CODEX_LAB_INVALID_AUTH', 'Codex authorization has no usable account identity; sign in again.'); }
}

export function createAuth(credentials, provider) {
  const store = createCredentialStore(credentials);
  const models = createModels({ credentials: store, authContext: NO_AMBIENT_AUTH });
  models.setProvider(provider);
  return {
    store,
    models,
    async resolve({ signal } = {}) {
      signal?.throwIfAborted();
      let result;
      try { result = await models.getAuth(NATIVE_PROVIDER, { signal }); }
      catch { signal?.throwIfAborted(); throw failure('CODEX_LAB_AUTH_FAILED', 'Codex authorization failed; use the plugin-owned sign-in flow.'); }
      signal?.throwIfAborted();
      const accessToken = result?.auth?.apiKey;
      if (!accessToken) throw failure('CODEX_LAB_AUTH_REQUIRED', 'Sign in to Codex Native Lab through the Harness authorization interface before using this experimental route.');
      return { accessToken, ...tokenIdentity(accessToken) };
    },
    flow: {
      key: AUTH_KEY,
      label: 'Codex Native Lab — separate experimental sign-in',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        if (session.method !== 'oauth') throw failure('CODEX_LAB_AUTH_METHOD', 'Only explicit OAuth sign-in is supported.');
        let declined = false;
        try {
          await models.login(NATIVE_PROVIDER, 'oauth', {
            signal: session.signal,
            prompt(p) {
              return session.prompt({ kind: p.type === 'manual_code' ? 'secret' : p.type, message: p.message,
                ...(p.placeholder === undefined ? {} : { placeholder: p.placeholder }),
                ...(p.options === undefined ? {} : { options: p.options }),
                ...(p.signal === undefined ? {} : { signal: p.signal }) }).catch(error => {
                  if (error instanceof AuthorizationDeclinedError) declined = true;
                  throw error;
                });
            },
            notify(event) {
              if (event.type === 'auth_url') session.notify({ message: event.instructions ?? 'Continue in your browser.', url: event.url });
              else if (event.type === 'device_code') session.notify({ message: 'Enter the displayed code in your browser.', url: event.verificationUri, code: event.userCode });
              else session.notify({ message: event.message });
            },
          });
        } catch { session.signal.throwIfAborted(); if (declined) throw new AuthorizationDeclinedError(); throw failure('CODEX_LAB_LOGIN_FAILED', 'Codex sign-in did not complete; no credential details are included in this diagnostic.'); }
      },
    },
  };
}
