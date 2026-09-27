// Opt-in installed VS Code M6 acceptance. No builds, downloads or ordinary-profile changes.
// Run: timeout 240s /usr/bin/node src/test/acceptance/annotation-host-run.js
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { runTests } = require('@vscode/test-electron');
const project = path.resolve(__dirname, '../../..');
async function main() {
    const code = process.env.M6_CODE || '/usr/share/code/code';
    const port = Number(process.env.M6_CDP_PORT || 9336);
    await fs.access(code);
    const run = await fs.mkdtemp(path.join(project, 'out/m6-host-'));
    console.log('M6_HOST_EVIDENCE', run);
    const inputs = ['src/extension.ts', 'src/engine.ts', 'src/publication-screen.ts', 'src/publication-annotations.ts',
        'literate/literate.literate', 'literate/engine.literate', 'literate/publication-screen.literate', 'literate/publication-annotations.literate'];
    const mainPath = path.join(project, 'out/main.js');
    let fresh = false;
    for (let attempt = 0; attempt < 45; attempt++) {
        const newest = Math.max(...await Promise.all(inputs.map(async file => (await fs.stat(path.join(project, file))).mtimeMs)));
        if ((await fs.stat(mainPath)).mtimeMs >= newest) { fresh = true; break; }
        if (!attempt) { console.log('Waiting up to 90 seconds for external generate/esbuild; not building.'); }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const timestamps = {};
    for (const file of ['out/main.js', ...inputs]) { timestamps[file] = (await fs.stat(path.join(project, file))).mtime.toISOString(); }
    await fs.writeFile(path.join(run, 'preflight.json'), JSON.stringify({ fresh, timestamps,
        status: fresh ? 'ready' : 'blocked: external build required; no host launched' }, null, 2));
    if (!fresh) { throw new Error('out/main.js remains older than annotation inputs; rerun after external build'); }
    await new Promise((resolve, reject) => {
        const server = net.createServer(); server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
    const workspace = path.join(run, 'workspace'), profile = path.join(run, 'profile');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.mkdir(path.join(run, 'extensions'));
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
        'files.autoSave': 'off', 'files.associations': { '*.literate': 'markdown' },
        'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'update.mode': 'none',
        'markdown.preview.openMarkdownLinks': 'inPreview'
    }, null, 2));
    await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ code, port, workspace, profile,
        mainMtime: (await fs.stat(mainPath)).mtime.toISOString(),
        mainSha256: createHash('sha256').update(await fs.readFile(mainPath)).digest('hex') }, null, 2));
    await runTests({ vscodeExecutablePath: code, extensionDevelopmentPath: project,
        extensionTestsPath: path.join(__dirname, 'annotation-host.js'),
        extensionTestsEnv: { M6_HOST_RUN: run, M6_CDP_PORT: String(port) },
        launchArgs: [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(run, 'extensions')}`,
            '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            '--no-sandbox', `--remote-debugging-port=${port}`] });
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
