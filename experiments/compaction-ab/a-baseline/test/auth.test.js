import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization';
import { AUTH_KEY, createCredentialStore, createAuth, tokenIdentity } from '../auth.js';
function token(account = 'fixture-account') { return `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`; }
const credential = () => ({ type: 'oauth', access: token(), refresh: 'fake-refresh', expires: Date.now() + 3600000 });
function storage(initial) {
  let current = initial;
  let tail = Promise.resolve();
  const keys = [];
  return {
    keys,
    async readRecord(key) { keys.push(key); return structuredClone(current); },
    async describeRecord(key) { keys.push(key); return { configured: current !== undefined, writable: true }; },
    async modifyRecord(key, mutate) {
      keys.push(key);
      const result = tail.then(async () => { const next = await mutate(structuredClone(current)); if (next !== undefined) current = structuredClone(next); return structuredClone(current); });
      tail = result.then(() => {}, () => {});
      return result;
    },
    async deleteRecord(key) { keys.push(key); await tail; current = undefined; },
    get current() { return current; },
  };
}
const record = c => ({ kind: 'grant', payload: { version: 1, credential: c } });

test('credential bridge reads and mutates only its own record under host lock', async () => {
  const db = storage(record(credential()));
  const store = createCredentialStore(db);
  const before = await store.read('openai-codex');
  before.access = 'caller modification';
  assert.notEqual((await store.read('openai-codex')).access, before.access);
  await store.modify('openai-codex', async c => ({ ...c, refresh: 'updated-fixture' }));
  assert.equal(db.current.payload.credential.refresh, 'updated-fixture');
  await assert.rejects(store.read('foreign'));
  assert.ok(db.keys.every(key => key === AUTH_KEY));
});

test('parallel auth refresh is serialized through public credential service', async () => {
  const db = storage(record({ ...credential(), expires: 1 }));
  let refreshes = 0;
  const base = openaiCodexProvider();
  const provider = { ...base, auth: { oauth: { ...base.auth.oauth,
    refresh: async c => { refreshes++; await Promise.resolve(); return { ...c, expires: Date.now() + 3600000 }; },
    toAuth: async c => ({ apiKey: c.access }),
  } } };
  const auth = createAuth(db, provider);
  const values = await Promise.all([auth.resolve(), auth.resolve(), auth.resolve()]);
  assert.equal(refreshes, 1);
  assert.equal(new Set(values.map(v => v.identity)).size, 1);
  assert.ok(db.keys.every(key => key === AUTH_KEY));
});

test('own OAuth flow persists via Models.login and translates manual codes into secret prompts', async () => {
  const db = storage();
  const prompts = [];
  const base = openaiCodexProvider();
  const provider = { ...base, auth: { oauth: { ...base.auth.oauth, login: async interaction => {
    await interaction.prompt({ type: 'manual_code', message: 'fixture code' });
    return credential();
  } } } };
  const auth = createAuth(db, provider);
  await auth.flow.run({ method: 'oauth', signal: new AbortController().signal, notify() {}, prompt: async p => { prompts.push(p); return 'synthetic-code'; } });
  assert.equal(prompts[0].kind, 'secret');
  assert.equal(db.current.payload.version, 1);
  assert.equal(db.current.payload.credential.type, 'oauth');
});

test('human decline remains cancellation rather than a provider failure', async () => {
  const db = storage();
  const base = openaiCodexProvider();
  const auth = createAuth(db, { ...base, auth: { oauth: { ...base.auth.oauth, login: async interaction => {
    await interaction.prompt({ type: 'text', message: 'fixture' });
    return credential();
  } } } });
  await assert.rejects(auth.flow.run({ method: 'oauth', signal: new AbortController().signal, notify() {}, prompt: async () => { throw new AuthorizationDeclinedError(); } }), AuthorizationDeclinedError);
  assert.equal(db.current, undefined);
});

test('missing or malformed grants fail safely and no ambient auth is attempted', async () => {
  const auth = createAuth(storage(), openaiCodexProvider());
  await assert.rejects(auth.resolve(), error => error.code === 'CODEX_LAB_AUTH_REQUIRED');
  const invalid = createAuth(storage({ kind: 'grant', payload: { secret: 'do-not-log' } }), openaiCodexProvider());
  await assert.rejects(invalid.resolve(), error => !String(error).includes('do-not-log'));
  assert.throws(() => tokenIdentity('raw-secret-token'), error => !String(error).includes('raw-secret-token'));
});

test('cancelled auth request never reads a credential record', async () => {
  const db = storage(record(credential()));
  const auth = createAuth(db, openaiCodexProvider());
  await assert.rejects(auth.resolve({ signal: AbortSignal.abort() }));
  assert.equal(db.keys.length, 0);
});
