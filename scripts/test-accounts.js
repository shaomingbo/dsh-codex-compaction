// Explicit paired-checkout validation; requires an explicitly named isolated
// account source (the release worktree), never a default or live workspace.
import { spawnSync } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAccountSnapshot } from './account-snapshot.js';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv.length !== 3) throw new Error('Usage: node scripts/test-accounts.js <account-source> — pass the isolated release worktree explicitly; no default workspace is used.');
const source = resolve(process.argv[2]);
const snapshot = await prepareAccountSnapshot(source);
const env = { PATH: process.env.PATH, HOME: snapshot.root, TMPDIR: process.env.TMPDIR,
  DSH_HOME: snapshot.runtimeHome, ACCOUNT_SNAPSHOT_ROOT: snapshot.root,
  ...(process.env.CODEX_REALTIME_DEADLINE === '1' ? { CODEX_REALTIME_DEADLINE: '1' } : {}) };
let complete = false;
try {
  // Keep unknown real provider keys/ambient auth out of test processes.
  const account = spawnSync(process.execPath, ['--test'], { cwd: snapshot.root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(snapshot.root, 'account-tests.log'), `${account.stdout ?? ''}\n${account.stderr ?? ''}`, { mode: 0o600 });
  if (account.status !== 0) throw new Error(`Account suite failed (${account.status ?? account.error?.code}); inspect ${snapshot.root}/account-tests.log`);
  const integration = spawnSync(process.execPath, ['--test', 'test/accounts.integration.js'], { cwd: root, env, encoding: 'utf8', timeout: env.CODEX_REALTIME_DEADLINE === '1' ? 240000 : 120000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(snapshot.root, 'integration-tests.log'), `${integration.stdout ?? ''}\n${integration.stderr ?? ''}`, { mode: 0o600 });
  if (integration.status !== 0) throw new Error(`Cross-plugin suite failed (${integration.status ?? integration.error?.code}); inspect ${snapshot.root}/integration-tests.log`);
  console.log(account.stdout.slice(-2200));
  console.log(integration.stdout);
  const lock = await readFile(join(snapshot.root, 'pnpm-lock.yaml'), 'utf8');
  if (lock !== await readFile(join(source, 'pnpm-lock.yaml'), 'utf8')) throw new Error('Frozen isolated account lock differs from the source lock.');
  console.log(JSON.stringify({ accountSource: source, authSdk: snapshot.authSdk, nativeSdk: snapshot.nativeSdk, accountSuite: 'passed', crossPluginSuite: 'passed', liveProfileTouched: false, realCredentialsUsed: false }, null, 2));
  complete = true;
} finally {
  if (complete) await rm(snapshot.root, { recursive: true, force: true });
  else console.error(`Retained isolated account snapshot: ${snapshot.root}`);
}
