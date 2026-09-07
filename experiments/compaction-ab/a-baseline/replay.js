// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
import { randomUUID } from 'node:crypto';
import { decodeCheckpoint } from './checkpoint.js';
import { isCompactCheckpointSource } from './compatibility.js';
import { ROUTE, NATIVE_PROVIDER, failure } from './constants.js';

const PREFIX = '<dsh-codex-compaction';
const markerTexts = message => (message.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string' && b.text.includes(PREFIX)).map(b => b.text);
function assertNativeText(items) {
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (['input_image', 'image', 'input_audio', 'audio'].includes(value.type)) throw failure('CODEX_LAB_UNSUPPORTED_IMAGE', 'This experimental version cannot replay native media items.');
    for (const child of Object.values(value)) visit(child);
  };
  visit(items);
}
export function hasNativeCheckpoint(messages) {
  return messages.some(message => isCompactCheckpointSource(message.source) && markerTexts(message).length > 0);
}
export function assertTextHistory(messages) {
  function check(blocks) {
    for (const block of blocks ?? []) {
      if (block.type === 'image') throw failure('CODEX_LAB_UNSUPPORTED_IMAGE', 'This experimental version does not support image history; use the ordinary Codex route in a separate session.');
      if (block.type === 'tool-result') check(block.content);
    }
  }
  messages.forEach(message => check(message.content));
}
/** Source provenance is checked BEFORE generic conversion. Wire strings alone confer no authority. */
export function prepareReplay(messages, expected) {
  assertTextHistory(messages);
  const replacements = new Map();
  const mapped = messages.map(message => {
    const texts = markerTexts(message);
    if (isCompactCheckpointSource(message.source) && texts.length) {
      if (texts.length !== 1) throw failure('CODEX_LAB_BAD_CHECKPOINT', 'A compact message must contain exactly one native envelope.');
      const checkpoint = decodeCheckpoint(texts[0], expected);
      if (!checkpoint) throw failure('CODEX_LAB_BAD_CHECKPOINT', 'Native envelope framing changed; refusing text fallback.');
      assertNativeText(checkpoint.items);
      const nonce = `DSH_NATIVE_REPLAY_${randomUUID()}`;
      replacements.set(nonce, checkpoint.items);
      return { ...message, content: [{ type: 'text', text: nonce }] };
    }
    // Source provider mapping is limited to our own outer alias. Foreign replay
    // state stays under LlmRuntime's ownership checks, never promoted by us.
    if (message.source?.kind === 'model' && message.source.provider === ROUTE) {
      return { ...message, source: { ...message.source, provider: NATIVE_PROVIDER } };
    }
    return message;
  });
  return { messages: mapped, replacements };
}

/** Expand exact unpredictable placeholders produced above, never arbitrary user marker strings. */
export function expandReplay(input, replacements) {
  if (!Array.isArray(input)) throw failure('CODEX_LAB_BAD_PAYLOAD', 'Codex generated an invalid request input.');
  const seen = new Set();
  const output = input.flatMap(item => {
    if (item?.role !== 'user' || !Array.isArray(item.content)) return [item];
    const matches = item.content.filter(c => c.type === 'input_text' && replacements.has(c.text));
    if (!matches.length) return [item];
    if (matches.length !== 1 || item.content.length !== 1 || seen.has(matches[0].text)) {
      throw failure('CODEX_LAB_BAD_PAYLOAD', 'Native replay placeholder changed during conversion.');
    }
    seen.add(matches[0].text);
    return structuredClone(replacements.get(matches[0].text));
  });
  if (seen.size !== replacements.size) throw failure('CODEX_LAB_BAD_PAYLOAD', 'Native replay checkpoint was lost during conversion.');
  return output;
}
