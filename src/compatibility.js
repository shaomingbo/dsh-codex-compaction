// Versioned public DSH seam. Native protocol/authentication is owned elsewhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGET_DSH, failure } from './constants.js';
export { Service } from '@deepseek-ai/cordis';
export { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
export { LlmAdapter, LlmError, BlockAssembler, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
export { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';

const REQUIRED = [
  '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-commands',
];
function assertVersions() {
  for (const id of REQUIRED) {
    const manifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`${id}/package.json`)), 'utf8'));
    if (manifest.version !== TARGET_DSH) throw failure('CODEX_NATIVE_UNSUPPORTED_HOST', `${id} ${manifest.version} is unsupported; this candidate targets ${TARGET_DSH}. Keep the matching reader for existing native histories.`);
  }
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
    codexBridge: ['describe', 'compact', 'readCheckpoint', 'estimateCheckpoint', 'setNativePreference', 'nativePreferenceStatus', 'nativeApplicability'] });
}
