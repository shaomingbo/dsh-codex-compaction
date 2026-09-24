import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PACKAGE_NAME = 'dsh-codex-compaction';
// Launcher versions are distinct from the plugin's pinned rc.1 host packages.
// This is an exact tested matrix, not a SemVer range or a host-version inference.
export const SUPPORTED_DSH_VERSIONS = Object.freeze(['0.1.7-alpha.1']);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const DEFAULT_SOURCE = `github:shaomingbo/dsh-codex-compaction#v${PACKAGE_VERSION}`;
const CLI_GUIDANCE = 'This migration candidate requires @deepseek-ai/dsh 0.1.7-alpha.1 and homogeneous 0.1.7-alpha.1 host packages. Installation/GUI acceptance is separate; no manifest fallback is available.';

export function validateProfile(profile) {
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) {
    throw new Error('--profile must be a simple name (letters, digits, hyphens or underscores), not a path');
  }
  return profile;
}

export function normalizeSource(source, cwd = process.cwd()) {
  if (source === DEFAULT_SOURCE) return source;
  if (typeof source === 'string' && source.startsWith('link:') && source.slice(5).trim() && !/[\x00-\x1f\x7f]/.test(source)) {
    return `link:${resolve(cwd, source.slice(5))}`;
  }
  throw new Error(`--source must be ${DEFAULT_SOURCE} or an explicit link:<local-path>; floating sources are not supported`);
}

function readSnapshot(path) {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw Object.assign(new Error(), { code: 'UNSAFE_PROFILE_MANIFEST' });
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read profile manifest ${path}: ${error.code ?? 'read failed'}`);
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(raw, path) {
  if (raw === null) return { installed: false, source: null, bundled: false, manifestExists: false };
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error(`Malformed profile manifest: ${path}`); }
  if (!object(manifest)
    || (manifest.dependencies !== undefined && !object(manifest.dependencies))
    || (manifest.dsh !== undefined && !object(manifest.dsh))
    || (manifest.dsh?.profile !== undefined && !object(manifest.dsh.profile))
    || (manifest.dsh?.profile?.bundles !== undefined && (!Array.isArray(manifest.dsh.profile.bundles) || !manifest.dsh.profile.bundles.every((entry) => typeof entry === 'string')))) {
    throw new Error(`Malformed profile manifest structure: ${path}`);
  }
  const hasDependency = Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME);
  const source = hasDependency ? manifest.dependencies[PACKAGE_NAME] : null;
  if (hasDependency && (typeof source !== 'string' || !source)) throw new Error(`Malformed plugin dependency in ${path}`);
  const count = (manifest.dsh?.profile?.bundles ?? []).filter((entry) => entry === PACKAGE_NAME).length;
  return { installed: source !== null && count === 1, source, bundled: count > 0, manifestExists: true };
}

function invoke(args, env) {
  // No shell, lifecycle control, direct pnpm calls or private DSH imports.
  return spawnSync('dsh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 300000 });
}

function success(result) {
  return !result.error && result.status === 0;
}

function checkCli(env, profile) {
  const version = invoke(['--version'], env);
  if (version.error?.code === 'ENOENT') throw new Error(`dsh is missing from PATH. ${CLI_GUIDANCE}`);
  if (!success(version)) throw new Error(`Cannot determine dsh CLI version. ${CLI_GUIDANCE}`);
  // --version is the version contract; never infer command success from prose.
  const actual = version.stdout.trim();
  if (!SUPPORTED_DSH_VERSIONS.includes(actual)) throw new Error(`Unsupported dsh CLI version ${JSON.stringify(actual)}; require exactly ${SUPPORTED_DSH_VERSIONS.join(' or ')}. ${CLI_GUIDANCE}`);
  // Do NOT probe `dsh plugin ... --help`: in published rc.1 help is forwarded
  // to pnpm AFTER profile initialization. Only launcher help is read-only.
  // The exact tested CLI version binds the public plugin grammar; mutation
  // availability is checked by its real exit code and manifest postconditions.
  if (!success(invoke(['--help'], env))) throw new Error(`dsh ${actual} lacks the required read-only launcher help capability. ${CLI_GUIDANCE}`);
}

/** Public CLI owns all writes and dependency transactions, including recovery.
 * rc.1 does not promise rollback: report changed manifests, never overwrite them.
 * Only package.json is inspected; credentials, settings and lockfiles are not read.
 */
export function runProfileAction({ command = 'install', profile = 'web', source = DEFAULT_SOURCE } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  if (!['install', 'status', 'uninstall'].includes(command)) throw new Error(`Unknown command: ${command}`);
  validateProfile(profile);
  source = normalizeSource(source, cwd);
  const home = resolve(cwd, env.DSH_HOME || join(homedir(), '.dsh'));
  const path = join(home, 'profiles', profile, 'package.json');
  const cliEnv = { ...env, DSH_HOME: home, npm_config_ignore_scripts: 'true' };
  checkCli(cliEnv, profile);
  for (const directory of [join(home, 'profiles'), join(home, 'profiles', profile)]) {
    try {
      const entry = lstatSync(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw Object.assign(new Error(), { code: 'UNSAFE_PROFILE_DIRECTORY' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot safely inspect profile directory (${error.code ?? 'read failed'}).`);
    }
  }
  const before = readSnapshot(path);
  const status = describe(before, path);
  if (command === 'status') return { ...status, profile, changed: false };
  if ((command === 'install' && status.installed && status.source === source)
    || (command === 'uninstall' && status.source === null && !status.bundled)) {
    return { ...status, profile, changed: false };
  }
  // pnpm 11's remove command rejects the --ignore-scripts shorthand. Its
  // documented config form enforces the same policy without a retry/fallback.
  const noScripts = command === 'install' ? '--ignore-scripts' : '--config.ignore-scripts=true';
  const args = ['plugin', '--profile', profile, command === 'install' ? 'add' : 'remove', command === 'install' ? source : PACKAGE_NAME, noScripts];
  const result = invoke(args, cliEnv);
  let after;
  try { after = readSnapshot(path); } catch {
    throw new Error('Cannot verify profile manifest after public dsh CLI operation. State is unknown; inspect the profile manually. No installer rollback was attempted.');
  }
  if (!success(result)) {
    const state = before === after ? 'Profile manifest is unchanged; dependency state was not verified.' : 'Profile manifest changed; rollback is NOT confirmed. Inspect the profile manually before retrying.';
    throw new Error(`Public dsh plugin ${command === 'install' ? 'add' : 'remove'} failed (exit ${result.status ?? result.error?.code ?? 'unknown'}). ${state} The public CLI owns the transaction; no installer rollback or fallback was attempted.`);
  }
  const final = describe(after, path);
  const satisfied = command === 'install'
    ? final.installed && final.source === source
    : final.source === null && !final.bundled;
  if (!satisfied) throw new Error(`Public dsh CLI exited successfully but ${command} manifest postcondition failed. Inspect ${path}; no fallback or automatic rollback was attempted.`);
  return { ...final, profile, changed: before !== after };
}
