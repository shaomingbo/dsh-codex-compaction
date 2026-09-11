import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SOURCE, PACKAGE_NAME } from '../src/profile-adapter.js';
import { parseArgs } from '../bin/install.js';

const installer = fileURLToPath(new URL('../bin/install.js', import.meta.url));
// This fake is an executable on a temp PATH, not an injected successful result.
// It models the documented rc.1 argv/manifest contract, NOT a real pnpm smoke.
const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_MODE;
if (args.length === 1 && args[0] === '--version') {
  console.log(process.env.FAKE_VERSION || '0.1.2-rc.1');
  process.exit(mode === 'version-fail' ? 9 : 0);
}
if (args.length === 1 && args[0] === '--help') {
  if (mode === 'no-help') process.exit(7);
  console.log('Arbitrary localized launcher help; no success parsing allowed');
  process.exit(0);
}
if (args[0] === 'plugin' && args.includes('--help')) {
  // Real rc.1 forwards --help to pnpm after initializing a profile.
  const target = path.join(process.env.DSH_HOME, 'profiles', args[2], 'package.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ name: 'unexpected-help-side-effect' }));
  process.exit(0);
}
if (args.length !== 6 || args[0] !== 'plugin' || args[1] !== '--profile'
  || !['add', 'remove'].includes(args[3]) || args[5] !== (args[3] === 'add' ? '--ignore-scripts' : '--config.ignore-scripts=true')
  || process.env.npm_config_ignore_scripts !== 'true') process.exit(92);
const target = path.join(process.env.DSH_HOME, 'profiles', args[2], 'package.json');
const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
if (mode === 'fail-clean') { console.log('Successfully installed!'); process.exit(8); }
if (mode === 'lie') { console.log('Success!'); process.exit(0); }
fs.mkdirSync(path.dirname(target), { recursive: true });
const manifest = original === null ? { name: 'profile', dsh: { profile: { bundles: ['base'] } } } : JSON.parse(original);
if (mode !== 'fail-init') {
  manifest.dependencies ??= {};
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  const name = '${PACKAGE_NAME}';
  if (args[3] === 'add') {
    manifest.dependencies[name] = mode === 'wrong-source' ? 'github:other/repo#main' : args[4];
    if (mode !== 'no-bundle' && !manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
    if (mode === 'duplicate') manifest.dsh.profile.bundles.push(name);
  } else {
    if (args[4] !== name) process.exit(93);
    delete manifest.dependencies[name];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(x => x !== name);
  }
}
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\\n');
if (mode === 'fail-dirty' || mode === 'fail-init') process.exit(8);
console.log('arbitrary output (not parsed)');
`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-codex-installer-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'dsh'), fake);
  chmodSync(join(bin, 'dsh'), 0o755);
  const home = join(root, 'home');
  const log = join(root, 'cli.log');
  const env = { PATH: bin, DSH_HOME: home, HOME: root, FAKE_LOG: log };
  const manifestPath = (profile = 'web') => join(home, 'profiles', profile, 'package.json');
  const raw = (profile) => existsSync(manifestPath(profile)) ? readFileSync(manifestPath(profile), 'utf8') : null;
  const seed = (manifest, profile) => {
    mkdirSync(dirname(manifestPath(profile)), { recursive: true });
    writeFileSync(manifestPath(profile), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = (args = [], extraEnv = {}, entry = installer) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { root, bin, home, env, run, raw, seed, calls, manifestPath };
}
const mutations = (f) => f.calls().filter((args) => args[0] === 'plugin' && !args.includes('--help'));
function ok(result) { assert.equal(result.status, 0, result.stderr); }
function fails(result, pattern) { assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, pattern); }

test('first/repeat install and uninstall use exact public argv and preserve unrelated fields', (t) => {
  const f = fixture(t);
  const seed = { name: 'custom', dependencies: { other: '1.2.3' }, scripts: { custom: 'untouched' }, dsh: { custom: 1, profile: { patchReload: 'live', bundles: ['base', 'other'] } } };
  f.seed(seed);
  ok(f.run());
  const installed = f.raw();
  const value = JSON.parse(installed);
  assert.equal(value.dependencies[PACKAGE_NAME], DEFAULT_SOURCE);
  assert.deepEqual(value.dsh.profile.bundles, ['base', 'other', PACKAGE_NAME]);
  assert.deepEqual(value.scripts, seed.scripts);
  assert.equal(value.dsh.profile.patchReload, 'live');
  ok(f.run(['install']));
  assert.equal(f.raw(), installed);
  ok(f.run(['uninstall']));
  assert.deepEqual(JSON.parse(f.raw()), seed);
  const removed = f.raw();
  ok(f.run(['uninstall']));
  assert.equal(f.raw(), removed);
  assert.deepEqual(mutations(f), [
    ['plugin', '--profile', 'web', 'add', DEFAULT_SOURCE, '--ignore-scripts'],
    ['plugin', '--profile', 'web', 'remove', PACKAGE_NAME, '--config.ignore-scripts=true'],
  ]);
});

test('exact alpha.3 CLI uses the same public transaction without broad version acceptance', (t) => {
  const f = fixture(t);
  const env = { FAKE_VERSION: '0.1.2-alpha.3' };
  ok(f.run(['status'], env));
  assert.equal(existsSync(f.home), false);
  ok(f.run([], env));
  const installed = f.raw();
  ok(f.run(['install'], env));
  ok(f.run(['status'], env));
  assert.equal(f.raw(), installed);
  ok(f.run(['uninstall'], env));
  ok(f.run(['uninstall'], env));
  assert.equal(mutations(f).length, 2);
});

test('exact 0.1.5-rc.1 CLI uses the same public transaction without broad version acceptance', (t) => {
  const f = fixture(t);
  const env = { FAKE_VERSION: '0.1.5-rc.1' };
  ok(f.run(['status'], env));
  assert.equal(existsSync(f.home), false);
  ok(f.run([], env));
  const installed = f.raw();
  ok(f.run(['install'], env));
  ok(f.run(['status'], env));
  assert.equal(f.raw(), installed);
  ok(f.run(['uninstall'], env));
  ok(f.run(['uninstall'], env));
  assert.equal(mutations(f).length, 2);
});

test('public CLI initializes absent profile; installer normalizes explicit relative links', (t) => {
  const f = fixture(t);
  ok(f.run(['--profile', 'sandbox_1', '--source', 'link:./local plugin']));
  assert.equal(JSON.parse(f.raw('sandbox_1')).dependencies[PACKAGE_NAME], `link:${join(f.root, 'local plugin')}`);
  assert.equal(f.raw(), null);
  assert.deepEqual(readdirSync(join(f.home, 'profiles')), ['sandbox_1']);
});

test('missing status and repeated uninstall are successful without creating a profile', (t) => {
  const f = fixture(t);
  for (const command of ['status', 'status', 'uninstall', 'uninstall']) {
    const result = f.run([command]);
    ok(result);
    assert.match(result.stdout, /not installed/);
    assert.equal(existsSync(f.home), false);
  }
  assert.deepEqual(mutations(f), []);
});

test('status is read-only for installed, uninstalled and incomplete manifests', (t) => {
  const f = fixture(t);
  for (const manifest of [{}, { dependencies: { [PACKAGE_NAME]: DEFAULT_SOURCE } }, { dependencies: { [PACKAGE_NAME]: DEFAULT_SOURCE }, dsh: { profile: { bundles: [PACKAGE_NAME] } } }]) {
    f.seed(manifest);
    const before = f.raw();
    const stat = statSync(f.manifestPath());
    ok(f.run(['status']));
    assert.equal(f.raw(), before);
    assert.equal(statSync(f.manifestPath()).mtimeMs, stat.mtimeMs);
  }
  assert.deepEqual(mutations(f), []);
});

test('help works without a CLI or profile, and direct symlink invocation works', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'installer-alias');
  symlinkSync(installer, alias);
  const result = f.run(['--help'], { PATH: '' }, alias);
  ok(result);
  assert.match(result.stdout, /0\.1\.2-rc\.1/);
  assert.match(result.stdout, /candidate/);
  assert.equal(existsSync(f.home), false);
  assert.deepEqual(f.calls(), []);
});

test('malformed and ambiguous args fail before invoking dsh', (t) => {
  const f = fixture(t);
  for (const args of [['install', 'install'], ['install', 'status'], ['uninstall', 'status'], ['--profile'], ['--source'], ['--profile', '--help'], ['--profile', '../escape'], ['--profile', '/tmp/escape'], ['--profile', ''], ['--profile', 'web', '--profile', 'other'], ['--source', DEFAULT_SOURCE, '--source', DEFAULT_SOURCE], ['--source', 'link:'], ['--source', 'latest'], ['--source', 'github:shaomingbo/dsh-codex-compaction#main'], ['--unknown'], ['bogus']]) {
    fails(f.run(args), /command|argument|option|profile|source/i);
  }
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.home), false);
  assert.equal(parseArgs([]).command, 'install');
});

test('missing CLI fails closed for every operation even if no profile exists', (t) => {
  const f = fixture(t);
  for (const command of ['install', 'status', 'uninstall']) fails(f.run([command], { PATH: '' }), /dsh is missing.*0\.1\.2-rc\.1/);
  assert.equal(existsSync(f.home), false);
});

test('wrong, unknown or failed version never mutates existing manifest', (t) => {
  const f = fixture(t);
  f.seed({ marker: 'retain' });
  const before = f.raw();
  for (const version of ['0.1.2-alpha.2', '0.1.2-alpha.4', '0.1.2-rc.2', '0.1.2', 'unknown', 'dsh 0.1.2-rc.1']) fails(f.run([], { FAKE_VERSION: version }), /Unsupported dsh CLI version/);
  fails(f.run([], { FAKE_MODE: 'version-fail' }), /Cannot determine/);
  assert.equal(f.raw(), before);
  assert.deepEqual(mutations(f), []);
});

test('only read-only launcher help is probed; plugin help must never initialize a profile', (t) => {
  const f = fixture(t);
  fails(f.run([], { FAKE_MODE: 'no-help' }), /read-only launcher help capability/);
  assert.deepEqual(mutations(f), []);
  assert.equal(existsSync(f.home), false);
  ok(f.run(['status']));
  assert.ok(f.calls().filter(args => args.includes('--help')).every(args => args.length === 1 && args[0] === '--help'));
  assert.equal(existsSync(f.home), false);
});

test('malformed manifest fails without mutation or content disclosure', (t) => {
  const f = fixture(t);
  for (const raw of ['not json sensitive-marker', 'null', '[]', '{"dependencies":[]}', '{"dsh":{"profile":{"bundles":"bad"}}}', '{"dsh":{"profile":{"bundles":[null]}}}']) {
    f.seed(raw);
    const result = f.run();
    fails(result, /Malformed profile manifest/);
    assert.doesNotMatch(result.stderr, /sensitive-marker/);
    assert.equal(f.raw(), raw);
  }
  assert.deepEqual(mutations(f), []);
});

test('CLI failure with preserved manifest is not reported as dependency rollback', (t) => {
  const f = fixture(t);
  f.seed({ dependencies: { other: '1' } });
  const before = f.raw();
  fails(f.run([], { FAKE_MODE: 'fail-clean' }), /manifest is unchanged; dependency state was not verified/);
  assert.equal(f.raw(), before);
  assert.equal(mutations(f).length, 1);
});

test('dirty CLI failure is detected, never overwritten by installer rollback', (t) => {
  const f = fixture(t);
  f.seed({ marker: 'keep' });
  const before = f.raw();
  fails(f.run([], { FAKE_MODE: 'fail-dirty' }), /rollback is NOT confirmed/);
  assert.notEqual(f.raw(), before);
  assert.equal(JSON.parse(f.raw()).dependencies[PACKAGE_NAME], DEFAULT_SOURCE);
  assert.equal(mutations(f).length, 1);
});

test('CLI-created profile on failed initial install is retained and reported', (t) => {
  const f = fixture(t);
  fails(f.run([], { FAKE_MODE: 'fail-init' }), /manifest changed; rollback is NOT confirmed/);
  assert.equal(JSON.parse(f.raw()).name, 'profile');
});

test('successful CLI prose cannot replace install manifest postconditions', (t) => {
  const f = fixture(t);
  for (const mode of ['lie', 'wrong-source', 'no-bundle', 'duplicate']) {
    f.seed({});
    fails(f.run([], { FAKE_MODE: mode }), /manifest postcondition failed/);
  }
});

test('uninstall checks postcondition and observes failed CLI rollback state', (t) => {
  const f = fixture(t);
  ok(f.run());
  const before = f.raw();
  fails(f.run(['uninstall'], { FAKE_MODE: 'lie' }), /manifest postcondition failed/);
  assert.equal(f.raw(), before);
  fails(f.run(['uninstall'], { FAKE_MODE: 'fail-clean' }), /manifest is unchanged/);
  assert.equal(f.raw(), before);
  fails(f.run(['uninstall'], { FAKE_MODE: 'fail-dirty' }), /rollback is NOT confirmed/);
  assert.equal(JSON.parse(f.raw()).dependencies[PACKAGE_NAME], undefined);
});

for (const kind of ['symlink', 'hardlink']) test(`rejects ${kind} profile manifests without reading or changing their target`, t => {
  const f = fixture(t);
  const target = join(f.root, 'unrelated.json');
  const raw = '{"privateFixture":"must-not-appear"}';
  writeFileSync(target, raw);
  mkdirSync(dirname(f.manifestPath()), { recursive: true });
  if (kind === 'symlink') symlinkSync(target, f.manifestPath()); else linkSync(target, f.manifestPath());
  const result = f.run(['status']);
  fails(result, /UNSAFE_PROFILE_MANIFEST/);
  assert.doesNotMatch(result.stderr, /must-not-appear/);
  assert.equal(readFileSync(target, 'utf8'), raw);
  assert.deepEqual(mutations(f), []);
});

test('rejects redirected profile directories before invoking mutations', t => {
  const f = fixture(t);
  const target = join(f.root, 'unrelated-directory');
  mkdirSync(target);
  mkdirSync(f.home);
  symlinkSync(target, join(f.home, 'profiles'));
  fails(f.run(), /UNSAFE_PROFILE_DIRECTORY/);
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(mutations(f), []);
});
