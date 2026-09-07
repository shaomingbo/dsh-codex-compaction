// Separate-process read validation of runner-owned synthetic JSONL only.
// This is NOT a DSH application boot or a real-account continuation.
import { readFile } from 'node:fs/promises';
import { Session } from './a-host.js';
import { readStructuredCheckpoint } from './b-backend.js';
import { decodeCheckpoint } from './a-baseline/checkpoint.js';
import { createHash } from 'node:crypto';
const [path, compactionId, provider, model, identity] = process.argv.slice(2);
if (!path || !compactionId || !provider || !model || !identity) throw new Error('Use through the A/B runner with its synthetic fixture arguments.');
const seed = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
const session = Session.create('ab-worker-restore', seed);
const message = session.deriveMessages().find(message => message.source.compactionId === compactionId);
if (!message) throw new Error('Restored fixture has no selected native checkpoint.');
const expected = { provider, model, identity };
const record = readStructuredCheckpoint(message, expected) ?? decodeCheckpoint(message.content.find(block => block.type === 'text' && block.text.startsWith('<dsh-codex-compaction-v1>'))?.text, expected);
if (!record) throw new Error('Restored checkpoint is invalid.');
console.log(JSON.stringify({ checkpointHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'), nativeItemCount: record.items.length }));
