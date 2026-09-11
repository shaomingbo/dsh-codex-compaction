// Versioned public DSH seam. Native protocol/authentication is owned elsewhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGET_DSH, TARGET_DSH_VERSIONS, failure } from './constants.js';
export { Service } from '@deepseek-ai/cordis';
export { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
export { LlmAdapter, LlmError, BlockAssembler, resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
export { PiAiAdapter, Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';

const REQUIRED = [
  '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-commands',
];
function resolvedHostVersion() {
  const versions = REQUIRED.map((id) => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`${id}/package.json`)), 'utf8'));
    return { id, version: manifest.version };
  });
  const host = versions[0]?.version;
  if (!TARGET_DSH_VERSIONS.includes(host) || versions.some((entry) => entry.version !== host)) {
    const detail = versions.map((entry) => `${entry.id}@${entry.version}`).join(', ');
    throw failure('CODEX_NATIVE_UNSUPPORTED_HOST', `Host packages ${detail} are unsupported; this candidate targets homogeneous ${TARGET_DSH_VERSIONS.join(' or ')}. Keep the matching reader for existing native histories.`);
  }
  return host;
}
function assertVersions() {
  resolvedHostVersion();
}
export function replaceSurfaceOp(start, end) {
  const host = resolvedHostVersion();
  return host === '0.1.5-rc.1' ? { op: 'replace', startSeq: start, endSeq: end } : { op: 'replace', start, end };
}
function systemMessageText(message) {
  if (typeof message?.content === 'string' && message.content.length > 0) return message.content;
  if (Array.isArray(message?.content)) {
    const text = message.content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
    if (text.length > 0) return text;
  }
  if (typeof message?.text === 'string' && message.text.length > 0) return message.text;
  return undefined;
}
function currentSystemPromptFromSurface(session) {
  const seqs = session?.surface?.nodes;
  if (!Array.isArray(seqs) || typeof session?.eventAt !== 'function') return { used: false };
  let text;
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type !== 'system/message') continue;
    const next = systemMessageText(event.data?.message);
    if (next !== undefined) text = next;
  }
  return { used: true, text };
}

export function compactionSystemPrompt(session, messages) {
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  if (typeof header?.system === 'string' && header.system.length > 0) return header.system;
  const surface = currentSystemPromptFromSurface(session);
  if (surface.used) return surface.text;
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : typeof session?.events === 'function' ? session.events() : session?.events;
  if (Array.isArray(events)) {
    let current;
    for (const event of events) {
      if (event?.type === 'system/message') current = event;
    }
    if (current !== undefined) return systemMessageText(current.data?.message);
  }
  const fromMessages = Array.isArray(messages)
    ? [...messages].reverse().find((message) => message?.role === 'system')
    : undefined;
  return systemMessageText(fromMessages);
}
function assertMethods(ctx, required) {
  for (const [service, methods] of Object.entries(required)) {
    if (methods.some(method => typeof ctx[service]?.[method] !== 'function')) throw failure('CODEX_NATIVE_MISSING_CAPABILITY', `Missing public ${service} interface required by the native candidate (${TARGET_DSH}).`);
  }
}
export function assertProviderCompatibility(ctx) {
  assertVersions();
  assertMethods(ctx, { llm: ['registerAdapter'] });
  if (typeof ctx.inject !== 'function') throw failure('CODEX_NATIVE_MISSING_CAPABILITY', 'Optional owner-runtime injection is required; no credential fallback is available.');
}
export function assertPolicyCompatibility(ctx) {
  assertVersions();
  assertMethods(ctx, { commands: ['register'], agentPresets: ['copy', 'read', 'resolve', 'serviceFor'],
    codexBridge: ['describe', 'compact', 'readCheckpoint', 'estimateCheckpoint', 'setNativePreference', 'nativePreferenceStatus', 'nativeApplicability', 'compactionProgress'] });
}
