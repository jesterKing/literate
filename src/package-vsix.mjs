import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('package.json contains an invalid extension version');
}

await mkdir(path.join(root, 'out'), { recursive: true });
const output = path.join('out', `${manifest.name}-${manifest.version}.vsix`);
const args = ['dlx', '@vscode/vsce@4.0.0', 'package', '--no-dependencies', '--out', output];
const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const child = spawn(yarn, args, { cwd: root, stdio: 'inherit', shell: false });
const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => signal ? reject(new Error(`VSCE terminated by ${signal}`)) : resolve(status));
});
if (code !== 0) { process.exitCode = code ?? 1; }
else { console.log(`Packaged ${output}`); }
