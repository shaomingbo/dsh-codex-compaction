// Isolated source/dependency snapshot for cross-plugin validation. Never install
// into the account workspace: its node_modules may point at a live profile.
import { cp, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex');

export async function prepareAccountSnapshot(source) {
  source = resolve(source);
  const manifestText = await readFile(join(source, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== 'dsh-token-usage' || manifest.dependencies?.['@earendil-works/pi-ai'] !== '0.82.1' || manifest.dependencies?.['pi-ai-codex-native'] !== 'npm:@earendil-works/pi-ai@0.84.4') throw new Error('Account snapshot requires the explicitly pinned owner and native SDK manifest.');
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-account-snapshot-'));
  const allowed = ['lib', 'test', 'bin', 'docs', 'bench', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.git', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CONTEXT.md', 'SPEC.md', 'V2-PLAN.md', 'LICENSE'];
  for (const name of allowed) {
    const from = join(source, name);
    try { await lstat(from); } catch (e) { if (e.code === 'ENOENT' && name !== 'package.json' && name !== 'lib' && name !== 'test') continue; throw e; }
    await cp(from, join(root, name), { recursive: true, errorOnExist: true, force: false, filter: async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing source symlink in isolated snapshot: ${path}`);
      return true;
    } });
  }
  const env = { ...process.env, DSH_HOME: join(root, 'runtime-home'), npm_config_ignore_scripts: 'true',
    // Isolated content store inside the snapshot; never the machine-global one.
    npm_config_store_dir: join(root, 'pnpm-store') };
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], { cwd: root, env, encoding: 'utf8', timeout: 300000 });
  await writeFile(join(root, 'snapshot-install.log'), `${install.stdout ?? ''}\n${install.stderr ?? ''}`, { mode: 0o600 });
  if (install.status !== 0) throw new Error(`Isolated account dependencies failed (${install.status ?? install.error?.code}); inspect ${root}/snapshot-install.log. Live profile was not used.`);
  const authSdk = JSON.parse(await readFile(join(root, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8')).version;
  const nativeSdk = JSON.parse(await readFile(join(root, 'node_modules/pi-ai-codex-native/package.json'), 'utf8')).version;
  if (authSdk !== '0.82.1' || nativeSdk !== '0.84.4') throw new Error('Isolated SDK versions do not match the pinned contract.');
  return { source, root, manifestHash: digest(manifestText), authSdk, nativeSdk, runtimeHome: env.DSH_HOME };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/account-snapshot.js <account-source-directory>');
  console.log(JSON.stringify(await prepareAccountSnapshot(process.argv[2]), null, 2));
}
