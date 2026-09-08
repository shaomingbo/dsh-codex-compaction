import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = message => { throw new Error(message); };
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
let count = 0;
for (const directory of ['src', 'bin', 'scripts', 'test']) {
  for (const path of files(join(root, directory)).filter(path => path.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) fail(`Syntax check failed: ${relative(root, path)}\n${result.stderr}`);
    count++;
    if (directory !== 'src') continue;
    const text = readFileSync(path, 'utf8');
    const imports = [...text.matchAll(/(?:from\s*|import\s*\()\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map(match => match[1]);
    if (imports.some(specifier => /\/(?:lib|src)(?:\/|$)/.test(specifier))) fail(`Private DSH import in ${path}`);
    if (imports.length && !['/compatibility.js', '/engine-host.js'].some(suffix => path.endsWith(suffix))) fail(`DSH imports must stay in the two host adapters: ${path}`);
    if (/from\s*['"](?:@earendil-works\/pi-ai|pi-ai-codex-native)/.test(text) || /createCredentialStore|registerFlow|resolveOAuth|Bearer\s/.test(text)) fail(`Credential/provider protocol ownership leaked into compaction production code: ${path}`);
    if (/__DSH_BOOT__|__ModuleLoader__|globalThis\.fetch\s*=/.test(text)) fail(`Forbidden host/global patch in ${path}`);
  }
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const phase of ['preinstall', 'install', 'postinstall', 'prepare']) if (manifest.scripts?.[phase]) fail(`Forbidden lifecycle hook: ${phase}`);
for (const path of [manifest.main, ...Object.values(manifest.exports), ...Object.values(manifest.bin), manifest.dsh.bundle.patch, 'README.md', 'README.zh.md', 'LICENSE']) {
  if (typeof path !== 'string' || !existsSync(join(root, path)) || !statSync(join(root, path)).isFile()) fail(`Missing package entry: ${path}`);
}
if (manifest.version !== '0.3.1') fail('Update source/tag/catalog contracts together when evolving the version.');
// Every packaged file entry must exist on disk, and the installer's pinned
// default source must stay in lockstep with the package version.
for (const entry of manifest.files) {
  if (typeof entry !== 'string' || !existsSync(join(root, entry))) fail(`Missing packaged file entry: ${entry}`);
}
{
  const adapter = readFileSync(join(root, 'src/profile-adapter.js'), 'utf8');
  const pinned = adapter.match(/DEFAULT_SOURCE = 'github:shaomingbo\/dsh-codex-compaction#(v[^']+)';/)?.[1];
  if (pinned !== `v${manifest.version}`) fail(`Installer DEFAULT_SOURCE (${pinned ?? 'absent'}) must equal the package version v${manifest.version}.`);
}
// The paired-checkout entry must never bake an account workspace path: the
// isolated account source is always passed explicitly on the command line.
if (manifest.scripts['test:accounts-integration'] !== 'node scripts/test-accounts.js') {
  fail(`test:accounts-integration must not bake an account source path: ${manifest.scripts['test:accounts-integration']}`);
}
for (const [id, version] of Object.entries(manifest.peerDependencies)) {
  if (id.startsWith('@deepseek-ai/dsh-') && version !== '0.1.2-rc.1') fail(`Unverified host peer range: ${id}@${version}`);
}
// git diff --check is empty for a brand-new untracked repository; also check
// the complete authored text so initial delivery receives a real whitespace gate.
const authored = ['src', 'bin', 'scripts', 'test', 'docs', '.github'].flatMap(directory => files(join(root, directory)));
for (const path of [...authored, join(root, 'README.md'), join(root, 'README.zh.md'), join(root, 'package.json')]) {
  const text = readFileSync(path, 'utf8');
  if (/^[<=>]{7}(?:\s|$)/m.test(text) || /[\t ]+\r?$/m.test(text)) fail(`Conflict marker or trailing whitespace: ${relative(root, path)}`);
}
console.log(`Checked ${count} JavaScript files, authored whitespace, public-import seam and package entry contracts.`);
