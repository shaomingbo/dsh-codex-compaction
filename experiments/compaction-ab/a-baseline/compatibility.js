// Archived A baseline: preserve pre-B production behavior for the A/B experiment.
// All DSH imports live at this versioned, public-export-only seam.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGET_DSH, failure } from './constants.js';
export { Service } from '@deepseek-ai/cordis';
export { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
export { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
export { LlmAdapter, LlmError, BlockAssembler, attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
export { PiAiAdapter, Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
export { credentialKey } from '@deepseek-ai/dsh-credentials';
export { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization';

const REQUIRED = [
  '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-commands',
];
export function assertCompatibility(ctx) {
  for (const id of REQUIRED) {
    const manifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`${id}/package.json`)), 'utf8'));
    if (manifest.version !== TARGET_DSH) {
      throw failure('CODEX_LAB_UNSUPPORTED_HOST', `${id} ${manifest.version} is unsupported; this experimental build targets ${TARGET_DSH}. Keep existing plugin/session versions or use a separately validated build.`);
    }
  }
  const required = { llm: ['registerAdapter'], credentials: ['readRecord', 'modifyRecord', 'deleteRecord', 'describeRecord'], authorization: ['registerFlow'], commands: ['register'], agentPresets: ['copy', 'read', 'resolve'] };
  for (const [service, methods] of Object.entries(required)) {
    if (methods.some(method => typeof ctx[service]?.[method] !== 'function')) {
      throw failure('CODEX_LAB_MISSING_CAPABILITY', `Missing public ${service} interface required by Codex Native Lab (${TARGET_DSH}).`);
    }
  }
}
