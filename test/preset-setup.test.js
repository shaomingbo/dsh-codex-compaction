import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, lstat, symlink, readdir, realpath } from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupPreset } from '../src/preset-setup.js';

const require = createRequire(import.meta.url);
// Published asset, resolved through the public package.json export; no DSH
// modules are imported and neither tests nor the fake roster evaluate YAML.
const packageRoot = dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json'));
const standard = await readFile(join(packageRoot, 'presets/standard/agent.cordis.yml'), 'utf8');
const expected = standard.replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: 'dsh-codex-compaction/compaction'");
const ID = 'codex-native-b';

async function fixture(t, text = standard) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-preset-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'system', 'standard');
  const user = join(root, 'user');
  const target = join(user, ID);
  await mkdir(source, { recursive: true });
  await mkdir(user);
  await writeFile(join(source, 'agent.cordis.yml'), text);
  await writeFile(join(source, 'asset.txt'), 'preserve this asset');
  const calls = [];
  const roster = {
    async resolve(id) {
      calls.push(['resolve', id]);
      const directory = id === 'standard' ? source : join(user, id);
      try { await lstat(directory); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw Object.assign(new Error('not found'), { code: 'agent-preset/not-found' });
      }
      return { id, trust: id === 'standard' ? 'system' : 'user', path: join(directory, 'agent.cordis.yml') };
    },
    async read(id) {
      calls.push(['read', id]);
      return readFile(join(id === 'standard' ? source : join(user, id), 'agent.cordis.yml'), 'utf8');
    },
    async copy(from, id, name) {
      calls.push(['copy', from, id, name]);
      assert.equal(from, 'standard');
      assert.equal(id, ID);
      await mkdir(target); // Non-overwriting public copy contract.
      await cp(source, target, { recursive: true });
      await writeFile(join(target, 'preset.yml'), `name: ${name}\n`);
    },
    async remove() { assert.fail('No cleanup may remove presets or clear user defaults.'); },
  };
  return { root, source, target, user, roster, calls, composition: join(target, 'agent.cordis.yml') };
}

const copyCount = (f) => f.calls.filter(([kind]) => kind === 'copy').length;

test('copies public shipped composition, changes exactly one line, keeps assets and next steps', async (t) => {
  const f = await fixture(t);
  const result = await setupPreset(f.roster);
  assert.match(result, /Legacy compatibility: created the archived structured B preset codex-native-b/);
  assert.match(result, /NOT needed for normal work/);
  assert.match(result, /compatibility-only for pre-existing structured sessions/);
  assert.match(result, /provider codex-native-lab/);
  assert.match(result, /existing ChatGPT connection in Accounts & Usage/);
  assert.match(result, /No session, default preset, provider selection, or login was changed/);
  assert.equal(await readFile(f.composition, 'utf8'), expected);
  assert.equal(await readFile(join(f.source, 'agent.cordis.yml'), 'utf8'), standard);
  assert.equal(await readFile(join(f.target, 'asset.txt'), 'utf8'), 'preserve this asset');
  assert.equal((await lstat(f.composition)).mode & 0o777, 0o600);
  assert.equal(copyCount(f), 1);
  assert.deepEqual((await readdir(f.target)).sort(), ['agent.cordis.yml', 'asset.txt', 'preset.yml']);
});

test('exact expected owned composition is idempotent without copy or rewriting metadata', async (t) => {
  const f = await fixture(t);
  await setupPreset(f.roster);
  await writeFile(join(f.target, 'preset.yml'), 'name: My name\n');
  const before = await lstat(f.composition);
  assert.match(await setupPreset(f.roster), /Legacy compatibility: already configured the archived structured B preset/);
  assert.equal((await lstat(f.composition)).ino, before.ino);
  assert.equal(copyCount(f), 1);
  assert.equal(await readFile(join(f.target, 'preset.yml'), 'utf8'), 'name: My name\n');
});

test('an existing user-modified composition is preserved and never recopied', async (t) => {
  const f = await fixture(t);
  await setupPreset(f.roster);
  const custom = `${expected}\n# user changes\n`;
  await writeFile(f.composition, custom);
  await assert.rejects(setupPreset(f.roster), /already exists with different composition/);
  assert.equal(await readFile(f.composition, 'utf8'), custom);
  assert.equal(copyCount(f), 1);
});

for (const [label, change] of [
  ['missing backend', (s) => s.replace('@deepseek-ai/dsh-compaction-basic', '@other/backend')],
  ['duplicate backend', (s) => `${s}\n- name: '@deepseek-ai/dsh-compaction-basic'\n`],
  ['duplicate realm', (s) => `${s}\n- id: compaction\n  name: cordis:group\n`],
  ['nearby backend config', (s) => s.replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: '@deepseek-ai/dsh-compaction-basic'\n      config:\n        auto: true")],
  ['extra realm config', (s) => s.replace('        tailChars: 1024', '        tailChars: 1024\n    - name: unexpected')],
  ['missing official command', (s) => s.replace('@deepseek-ai/dsh-command-compact', '@other/command')],
  ['changed pruner', (s) => s.replace('        tailChars: 1024', '        tailChars: 1000')],
  ['nested realm', (s) => s.replace('- id: compaction\n', '  - id: compaction\n')],
]) {
  test(`fails before copy for ${label}`, async (t) => {
    const f = await fixture(t, change(standard));
    await assert.rejects(setupPreset(f.roster), /Unexpected standard compaction realm/);
    assert.equal(copyCount(f), 0);
    assert.deepEqual(await readdir(f.user), []);
  });
}

test('does not execute !!js anywhere in source text', async (t) => {
  const source = standard.replace("disabled: !!js process.platform === 'win32'", "disabled: !!js (() => { throw new Error('MUST NOT EVALUATE') })()");
  const f = await fixture(t, source);
  await setupPreset(f.roster);
  assert.match(await readFile(f.composition, 'utf8'), /MUST NOT EVALUATE/);
});

for (const location of ['asset', 'composition', 'ancestor']) {
  test(`refuses source ${location} symlinks before copy`, async (t) => {
    const f = await fixture(t);
    if (location === 'ancestor') {
      const link = join(f.root, 'linked-system');
      await symlink(dirname(f.source), link);
      const originalResolve = f.roster.resolve;
      f.roster.resolve = async (id) => ({ ...await originalResolve(id), path: join(link, 'standard', 'agent.cordis.yml') });
    } else {
      const path = join(f.source, location === 'asset' ? 'asset.txt' : 'agent.cordis.yml');
      const destination = join(f.root, 'external');
      await writeFile(destination, location === 'asset' ? 'asset' : standard);
      await rm(path);
      await symlink(destination, path);
    }
    await assert.rejects(setupPreset(f.roster), /symlink/);
    assert.equal(copyCount(f), 0);
  });
}

test('refuses a target composition symlink and never changes its referent', async (t) => {
  const f = await fixture(t);
  await mkdir(f.target);
  await symlink(join(f.source, 'agent.cordis.yml'), f.composition);
  await assert.rejects(setupPreset(f.roster), /symlink/);
  assert.equal(await readFile(join(f.source, 'agent.cordis.yml'), 'utf8'), standard);
  assert.equal(copyCount(f), 0);
});

test('aborted signal performs no roster operations', async (t) => {
  const f = await fixture(t);
  await assert.rejects(setupPreset(f.roster, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
});

test('abort during copy preserves newly created target and reports actionable state', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const copy = f.roster.copy;
  f.roster.copy = async (...args) => { await copy(...args); controller.abort(); };
  await assert.rejects(setupPreset(f.roster, { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /Inspect codex-native-b/);
    return true;
  });
  assert.equal(await readFile(f.composition, 'utf8'), standard);
});

test('partial copy failure preserves uncertain files and reports manual recovery', async (t) => {
  const f = await fixture(t);
  f.roster.copy = async () => {
    await mkdir(f.target);
    await writeFile(f.composition, 'partial or concurrent data');
    throw new Error('disk full');
  };
  await assert.rejects(setupPreset(f.roster), /copy failed: disk full.*Inspect codex-native-b/);
  assert.equal(await readFile(f.composition, 'utf8'), 'partial or concurrent data');
});

test('concurrent change during roster.copy is preserved', async (t) => {
  const f = await fixture(t);
  const copy = f.roster.copy;
  f.roster.copy = async (...args) => { await copy(...args); await writeFile(f.composition, 'user edit'); };
  await assert.rejects(setupPreset(f.roster), /differs from the validated source/);
  assert.equal(await readFile(f.composition, 'utf8'), 'user edit');
});

test('concurrent edit just before commit is preserved and own temporary file is cleaned', async (t) => {
  const f = await fixture(t);
  let edited = false;
  const signal = {
    get aborted() {
      let names = [];
      try { names = readdirSync(f.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!edited && names.some((name) => name.endsWith('.tmp'))) {
        edited = true;
        writeFileSync(f.composition, 'concurrent edit');
      }
      return false;
    },
  };
  await assert.rejects(setupPreset(f.roster, { signal }), /changed concurrently/);
  assert.equal(edited, true);
  assert.equal(await readFile(f.composition, 'utf8'), 'concurrent edit');
  assert.equal((await readdir(f.target)).some((name) => name.endsWith('.tmp')), false);
});

test('unrecognized resolve error does not masquerade as target absence', async (t) => {
  const f = await fixture(t);
  const resolve = f.roster.resolve;
  f.roster.resolve = async (id) => {
    if (id === ID) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return resolve(id);
  };
  await assert.rejects(setupPreset(f.roster), /permission denied/);
  assert.equal(copyCount(f), 0);
});

test('standard must be a system preset; existing target must be user-owned', async (t) => {
  const f = await fixture(t);
  const resolve = f.roster.resolve;
  f.roster.resolve = async (id) => ({ ...await resolve(id), trust: 'user' });
  await assert.rejects(setupPreset(f.roster), /identity, trust/);
  assert.equal(copyCount(f), 0);
  f.roster.resolve = resolve;
  await setupPreset(f.roster);
  f.roster.resolve = async (id) => ({ ...await resolve(id), trust: 'system' });
  await assert.rejects(setupPreset(f.roster), /identity, trust/);
  assert.equal(copyCount(f), 1);
});

test('aborting immediately before atomic commit leaves the original and removes only its temporary file', async (t) => {
  const f = await fixture(t);
  const signal = {
    get aborted() {
      try { return readdirSync(f.target).some((name) => name.endsWith('.tmp')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    },
  };
  await assert.rejects(setupPreset(f.roster, { signal }), { name: 'AbortError' });
  assert.equal(await readFile(f.composition, 'utf8'), standard);
  assert.equal((await readdir(f.target)).some((name) => name.endsWith('.tmp')), false);
});

test('a target symlink introduced by copy is preserved without writing its referent', async (t) => {
  const f = await fixture(t);
  const copy = f.roster.copy;
  f.roster.copy = async (...args) => {
    await copy(...args);
    await rm(f.composition);
    await symlink(join(f.source, 'agent.cordis.yml'), f.composition);
  };
  await assert.rejects(setupPreset(f.roster), /symlink.*Inspect codex-native-b/);
  assert.equal(await readFile(join(f.source, 'agent.cordis.yml'), 'utf8'), standard);
  assert.equal((await lstat(f.composition)).isSymbolicLink(), true);
});

test('source changes between resolution and public read fail before copy', async (t) => {
  const f = await fixture(t);
  f.roster.read = async () => `${standard}\n# concurrent edit\n`;
  await assert.rejects(setupPreset(f.roster), /changed while reading/);
  assert.equal(copyCount(f), 0);
});

test('no dependency on private roster state or mutation methods', async () => {
  await assert.rejects(setupPreset({}), /public resolve/);
});
