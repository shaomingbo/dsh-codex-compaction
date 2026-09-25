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
  // The only intentional deltas beyond the backend swap: the preset-local
  // native policy row (nativeDefault), the preset display name/description,
  // and the pinned per-pressure compaction budget. Strip those exact blocks,
  // then the plugin lists must be byte-identical.
  const blocks = [
    ['              # The native-default policy publishes a preset service, so it',
     '              # lives INSIDE the compaction isolate realm (the real registry',
     '              # rejects root-leaking preset services). Mounts before the',
     '              # engine that resolves it.',
     '              - id: codex-native-policy',
     '                name: dsh-codex-compaction/native-policy',
     '                config:',
     '                  nativeDefault: true',
     ''].join('\n'),
    ["                # Pin Basic's public per-pressure commit budget: one commit",
     '                # attempt per pressure loop on this preset (fewer back-to-back',
     '                # compactions in the same pressure cycle). Standard presets',
     '                # keep their own declaration unchanged.',
     '                config:',
     '                  compactionRetries: 1',
     ''].join('\n'),
    '              codexNativePolicy: true\n',
    '        name: Codex Native\n',
    '        description: 原生压缩默认开启；适合长任务；由 Accounts & Usage 提供账号能力。\n',
  ];
  let stripped = bundle;
  for (const block of blocks) {
    assert.ok(stripped.includes(block), 'expected delta block missing from the bundle');
    stripped = stripped.replace(block, '');
  }
  const plugins = text => text.slice(text.indexOf('        plugins:\n'));
  assert.equal(plugins(stripped), plugins(standard).replace("name: '@deepseek-ai/dsh-compaction-basic'", "name: 'dsh-codex-compaction/compaction'"));
  assert.match(bundle, /id: codex-native-b\n        name: Codex Native\n/);
  assert.match(bundle, /nativeDefault: true\n/);
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
