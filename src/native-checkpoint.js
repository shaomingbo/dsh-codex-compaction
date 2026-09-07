// New-path native carrier recognition. The seam returns the owner codec's
// existing versioned text envelope (<dsh-codex-compaction-v1>…) directly as
// the summary block; official basic frames and commits it with its own
// checkpoint source. Detection therefore reuses the long-standing
// prefix-strict rule on compact-checkpoint messages: an envelope-prefixed
// block marks a carrier, while quotes inside ordinary text never match.
// Detection and validation stay separate — a shape-detected carrier that
// fails decoding fails closed instead of falling back to the ordinary path.
import { CODEC_PREFIX } from './runtime-adapter.js';

/** First line of the stock basic compaction instruction (pinned rc.1). */
export const BASIC_INSTRUCTION_FIRST_LINE = 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.';
export const BASIC_INSTRUCTION_PLUGIN = 'dsh-compaction-basic';

const isText = block => block?.type === 'text' && typeof block.text === 'string';

/**
 * Recognize the real stock basic summarization tail: a user message whose
 * source identifies the official plugin and whose single text block starts
 * with the pinned instruction. Never pops an ordinary user message.
 */
export function basicInstructionTail(message) {
  if (message?.source?.kind !== 'plugin' || message.source.plugin !== BASIC_INSTRUCTION_PLUGIN) return false;
  const blocks = message?.content;
  return Array.isArray(blocks) && blocks.length === 1 && isText(blocks[0])
    && blocks[0].text.startsWith(BASIC_INSTRUCTION_FIRST_LINE);
}

/** Whether a committed compaction summary's blocks carry a native envelope. */
export function blocksCarryNativeEnvelope(blocks) {
  return Array.isArray(blocks) && blocks.some(block => isText(block) && block.text.startsWith(CODEC_PREFIX));
}
