// Explicit opt-in: real published CLI + pnpm, isolated DSH_HOME, no server boot.
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProfileAction } from '../src/profile-adapter.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'dsh-codex-cli-validation-'));
const env = { ...process.env, DSH_HOME: home, PATH: join(root, 'node_modules', '.bin') + delimiter + process.env.PATH };
const options = { env, cwd: root };
const source = `link:${root}`;
const manifest = join(home, 'profiles', 'web', 'package.json');
const results = [];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
let complete = false;
try {
  const before = runProfileAction({ command: 'status', source }, options);
  requireValue(!before.manifestExists, 'Absent status unexpectedly created a profile.');
  try { await stat(manifest); throw new Error('Read-only status wrote a manifest.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  results.push('absent status is read-only');
  const first = runProfileAction({ source }, options);
  requireValue(first.installed && first.changed, 'First install failed its postcondition.');
  results.push('real public CLI install');
  const bytes = await readFile(manifest, 'utf8');
  const repeated = runProfileAction({ source }, options);
  requireValue(repeated.installed && !repeated.changed, 'Repeated installation changed the manifest.');
  requireValue((await readFile(manifest, 'utf8')) === bytes, 'Repeated installation wrote the manifest.');
  results.push('repeat install is idempotent');
  const status = runProfileAction({ command: 'status', source }, options);
  requireValue(status.installed && !status.changed, 'Installed status is invalid.');
  results.push('installed status is read-only');
  const dump = spawnSync('dsh', ['--profile', 'web', '--dump-config'], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  requireValue(dump.status === 0, `Non-booting --dump-config failed (${dump.status ?? dump.error?.code}).`);
  requireValue(/name:\s*['"]?dsh-codex-compaction(?:['"]?\s|$)/m.test(dump.stdout), 'Composed dump lacks the plugin entry.');
  requireValue(/name:\s*['"]?dsh-codex-compaction\/provider(?:['"]?\s|$)/m.test(dump.stdout), 'Composed dump lacks the separate provider bridge entry.');
  results.push('public --dump-config contains policy and provider entries; no boot');
  const removed = runProfileAction({ command: 'uninstall', source }, options);
  requireValue(!removed.installed && !removed.bundled && removed.source === null, 'Uninstall failed postconditions.');
  results.push('real public CLI uninstall');
  const removedAgain = runProfileAction({ command: 'uninstall', source }, options);
  requireValue(!removedAgain.changed && !removedAgain.installed, 'Repeated uninstall is not idempotent.');
  results.push('repeat uninstall is idempotent');
  complete = true;
  console.log(JSON.stringify({ cliVersion: '0.1.2-rc.1', profile: 'web', sourceKind: 'local-link', checks: results, serverStarted: false, liveProfileTouched: false, publishedTagValidated: false }, null, 2));
} finally {
  if (complete) await rm(home, { recursive: true, force: true });
  else console.error(`Isolated validation failed; temporary artifacts retained for inspection: ${home}`);
}
