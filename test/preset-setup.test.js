import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupPreset } from '../src/preset-setup.js';

test('bundle mirrors every official standard plugin declaration, changing only backend', async () => {
  const root = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json')));
  const standard = await readFile(join(root, 'presets/standard.patch.yml'), 'utf8');
  const bundle = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const plugins = text => text.slice(text.indexOf('        plugins:\n'));
  assert.equal(plugins(bundle), plugins(standard).replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: 'dsh-codex-compaction/compaction'"));
  assert.match(bundle, /id: codex-native-b\n        order: 9/);
});
test('setup resolves the declarative id without copy/read/filesystem mutation', async () => {
  const seen = [];
  const roster = { resolve: async id => { seen.push(id); return { id }; }, copy() { throw Error('forbidden'); }, read() { throw Error('forbidden'); } };
  assert.match(await setupPreset(roster), /No preset file/);
  assert.deepEqual(seen, ['codex-native-b']);
  await assert.rejects(setupPreset(roster, { signal: AbortSignal.abort() }));
  assert.deepEqual(seen, ['codex-native-b']);
});
test('missing declaration refuses rather than rewriting an official preset', async () => {
  await assert.rejects(setupPreset({ resolve: async () => { throw Error('missing declaration'); } }), /missing declaration/);
});
