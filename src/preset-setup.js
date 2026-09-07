import { constants, lstatSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PRESET as ID, ROUTE, DISPLAY_NAME } from './constants.js';
const BACKEND = "name: '@deepseek-ai/dsh-compaction-basic'";
const NATIVE = "name: 'dsh-codex-compaction/compaction'";
const MAX_BYTES = 1024 * 1024;
// Content-matched grammar for the published 0.1.2-rc.1 compaction realm.
// Deliberately not a YAML interpreter: !!js elsewhere remains inert text.
const REALM = `- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`;

function abort(signal) {
  if (signal?.aborted) {
    const error = new Error('Preset setup cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function expectedComposition(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) {
    throw new Error('The standard composition is missing or too large; nothing was copied.');
  }
  const lines = text.split('\n');
  const start = lines.indexOf('- id: compaction');
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('- ')) end++;
  const section = lines.slice(start, end).join('\n');
  const tail = section.slice(REALM.length);
  const exactlyOnce = (needle) => text.split(needle).length === 2;
  if (start < 0 || !section.startsWith(REALM)
      || tail.split('\n').some((line) => line.trim() && !line.startsWith('#'))
      || !exactlyOnce('- id: compaction\n')
      || !exactlyOnce('@deepseek-ai/dsh-compaction-basic')
      || !exactlyOnce('- id: compaction-basic')
      || !exactlyOnce('@deepseek-ai/dsh-command-compact')
      || !exactlyOnce('@deepseek-ai/dsh-compaction-tool-result-pruner')
      || text.includes('dsh-codex-compaction/compaction')) {
    throw new Error('Unexpected standard compaction realm (missing, duplicate, or ambiguous backend/config); nothing was copied. Use the shipped DSH 0.1.2-rc.1 standard preset.');
  }
  return text.replace(BACKEND, NATIVE);
}

function pathParts(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Preset composition must have a canonical absolute path.');
  }
  const root = parse(path).root;
  const parts = [root];
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    parts.push(join(parts.at(-1), part));
  }
  return parts;
}

async function noSymlinkPath(path) {
  for (const part of pathParts(path)) {
    const stat = await lstat(part);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in preset path: ${part}`);
    if (part !== path && !stat.isDirectory()) throw new Error('Invalid preset ancestor.');
  }
}

async function noSymlinkTree(directory, signal) {
  let count = 0;
  async function visit(path) {
    abort(signal);
    if (++count > 4096) throw new Error('Preset tree exceeds safety limit.');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in preset tree: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (!stat.isFile()) throw new Error(`Refusing special file in preset: ${path}`);
  }
  await noSymlinkPath(directory);
  await visit(directory);
}

function validatePreset(preset, id, trust) {
  if (!preset || preset.id !== id || preset.trust !== trust
      || basename(preset.path ?? '') !== 'agent.cordis.yml'
      || basename(dirname(preset.path)) !== id) {
    throw new Error(`Unexpected ${id} preset identity, trust, or composition path.`);
  }
  pathParts(preset.path);
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function snapshot(path) {
  await noSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1) {
      throw new Error('Refusing non-regular, hard-linked, or oversized composition.');
    }
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameFile(stat, after) || !sameFile(stat, await lstat(path))) {
      throw new Error('Preset composition changed while reading; retry after edits finish.');
    }
    return { stat, text };
  } finally {
    await handle.close();
  }
}

function assertUnchangedSync(path, saved) {
  for (const part of pathParts(path)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error('Preset path became a symlink.');
  }
  const current = lstatSync(path);
  if (!sameFile(saved.stat, current) || !current.isFile() || current.nlink !== 1
      || readFileSync(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }) !== saved.text) {
    throw new Error('Preset composition changed concurrently; your changes were preserved.');
  }
}

async function replaceComposition(path, saved, text, signal) {
  const temporary = join(dirname(path), `.codex-setup-${randomUUID()}.tmp`);
  let handle;
  let ownStat;
  try {
    abort(signal);
    await noSymlinkPath(dirname(path));
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownStat = await handle.stat();
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    abort(signal);
    // No asynchronous turn between the last identity/content checks and rename.
    // This is optimistic concurrency, not an OS-wide lock against hostile writers.
    assertUnchangedSync(path, saved);
    const tempStat = lstatSync(temporary);
    if (tempStat.isSymbolicLink() || tempStat.dev !== ownStat.dev || tempStat.ino !== ownStat.ino) {
      throw new Error('Preset temporary file changed concurrently.');
    }
    renameSync(temporary, path);
    ownStat = undefined;
  } finally {
    await handle?.close();
    if (ownStat) {
      // Only unlink our unique temporary file; never delete the preset directory.
      try {
        for (const part of pathParts(dirname(temporary))) {
          if (lstatSync(part).isSymbolicLink()) throw new Error('Temporary directory became a symlink.');
        }
        const current = lstatSync(temporary);
        if (!current.isSymbolicLink() && current.dev === ownStat.dev && current.ino === ownStat.ino) unlinkSync(temporary);
      } catch { /* An uncertain temporary file is safer left for manual inspection. */ }
    }
  }
}

function nextSteps(existing) {
  return `Legacy compatibility: ${existing ? 'already configured' : 'created'} the archived structured B preset ${ID} (${DISPLAY_NAME}). This preset is NOT needed for normal work — new sessions should stay on the standard preset with provider openai-codex and use /codex-native for native compaction. The B preset is compatibility-only for pre-existing structured sessions: select it for a new/empty session, then explicitly select provider ${ROUTE} and a supported model. Use the existing ChatGPT connection in Accounts & Usage; no separate login or grant migration is needed. Use /compact for manual compression and /codex-context for the disclosed estimate. No session, default preset, provider selection, or login was changed.`;
}

/**
 * Explicit-human-command-only helper. Uses only the public roster contract.
 * @param {{resolve: Function, read: Function, copy: Function}} roster
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<string>} Human-readable result and opt-in next steps.
 */
export async function setupPreset(roster, { signal } = {}) {
  abort(signal);
  for (const method of ['resolve', 'read', 'copy']) {
    if (typeof roster?.[method] !== 'function') throw new Error(`Preset roster lacks public ${method}(); DSH 0.1.2-rc.1 is required.`);
  }
  const source = await roster.resolve('standard');
  abort(signal);
  validatePreset(source, 'standard', 'system');
  await noSymlinkTree(dirname(source.path), signal);
  const original = await snapshot(source.path);
  const sourceText = await roster.read('standard');
  abort(signal);
  if (sourceText !== original.text) throw new Error('Standard preset changed while reading; nothing was copied.');
  const expected = expectedComposition(sourceText);
  let existing;
  try {
    existing = await roster.resolve(ID);
  } catch (error) {
    if (error?.code !== 'agent-preset/not-found') throw error;
  }
  abort(signal);
  if (existing) {
    validatePreset(existing, ID, 'user');
    await noSymlinkTree(dirname(existing.path), signal);
    const current = await snapshot(existing.path);
    abort(signal);
    if (current.text !== expected) throw new Error(`Preset ${ID} already exists with different composition; preserved unchanged. Inspect it and choose another id or explicitly remove it yourself before retrying.`);
    return nextSteps(true);
  }

  // copy() is publicly documented as non-overwriting. If it rejects, ownership
  // of any partial directory is uncertain; never remove it or clear defaults.
  let copied = false;
  try {
    await noSymlinkTree(dirname(source.path), signal);
    assertUnchangedSync(source.path, original);
    abort(signal);
    await roster.copy('standard', ID, DISPLAY_NAME);
    copied = true;
    abort(signal);
    const target = await roster.resolve(ID);
    abort(signal);
    validatePreset(target, ID, 'user');
    await noSymlinkTree(dirname(target.path), signal);
    const saved = await snapshot(target.path);
    if (saved.text !== original.text) throw new Error('Copied composition differs from the validated source; refusing to overwrite it.');
    await replaceComposition(target.path, saved, expected, signal);
    const committed = await snapshot(target.path);
    abort(signal);
    if (committed.text !== expected) throw new Error('Composition changed after commit.');
    return nextSteps(false);
  } catch (cause) {
    const error = new Error(`Preset setup ${copied ? 'did not finish cleanly' : 'copy failed'}: ${cause.message} Inspect ${ID} in the preset roster before retrying; any created preset was preserved (it may still use the standard backend). No automatic removal or default changes were attempted.`, { cause });
    if (cause.name === 'AbortError') error.name = 'AbortError';
    throw error;
  }
}
