// Installed-host M5 launcher. No build, download, installation, or ordinary-profile settings changes.
// Run: timeout 240s /usr/bin/node src/test/acceptance/publication-host-run.js
// Optional overrides: M5_CODE, M5_FONT_MANIFEST, M5_ULEM, M5_CDP_PORT.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { runTests } = require('@vscode/test-electron');
const project = path.resolve(__dirname, '../../..');
async function inventory(root, relative = '') {
    const result = {};
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.posix.join(relative, entry.name), file = path.join(root, name);
        if (entry.isDirectory()) { Object.assign(result, await inventory(root, name)); }
        else {
            if (!entry.isFile()) { throw new Error(`Not an ordinary fixture file: ${file}`); }
            const stat = await fs.stat(file, { bigint: true });
            result[name] = { sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), mtime: String(stat.mtimeNs) };
        }
    }
    return result;
}
exports.inventory = inventory;
async function main() {
    const code = process.env.M5_CODE || '/usr/share/code/code';
    const port = Number(process.env.M5_CDP_PORT || 9334);
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
    for (const file of [code, '/usr/bin/node', '/usr/bin/chromium-browser', path.join(project, 'out/main.js'), path.join(project, 'out/publication-helper.cjs')]) { await fs.access(file); }
    const run = await fs.mkdtemp(path.join(project, 'out/m5-host-'));
    const workspace = path.join(run, 'workspace'), profile = path.join(run, 'profile');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.mkdir(path.join(run, 'extensions'));
    const settings = { 'files.autoSave': 'off', 'workbench.startupEditor': 'none',
        'extensions.autoUpdate': false, 'update.mode': 'none',
        'literate.publication.nodePath': '/usr/bin/node', 'literate.publication.browserPath': '/usr/bin/chromium-browser' };
    const manifest = process.env.M5_FONT_MANIFEST || path.join(project, 'out/portable-font-lilex/project/fonts.json');
    try {
        const parsed = JSON.parse(await fs.readFile(manifest, 'utf8'));
        const files = new Set();
        for (const family of Object.values(parsed.families)) {
            for (const [key, value] of Object.entries(family)) {
                if (key === 'licenses') { value.forEach(file => files.add(file)); }
                else { files.add(typeof value === 'string' ? value : value.file); }
            }
        }
        for (const file of files) {
            if (path.isAbsolute(file) || file.split('/').includes('..')) { throw new Error('Unsafe font fixture path'); }
            await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
            await fs.copyFile(path.resolve(path.dirname(manifest), file), path.join(workspace, file));
        }
        await fs.copyFile(manifest, path.join(workspace, 'fonts.json'));
        settings['literate.publication.fontManifest'] = 'fonts.json';
    } catch (error) {
        if (error.code !== 'ENOENT' || process.env.M5_FONT_MANIFEST) { throw error; }
        console.log('No optional font fixture; using installed fonts.');
    }
    const ulem = path.resolve(process.env.M5_ULEM || path.join(project, 'out/publication-renderer/ulem.sty'));
    await fs.access(ulem);
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
    await fs.writeFile(path.join(workspace, 'index.literate'), '# SavedIndexMarker\n\n[Chapter](chapter.html)\n');
    await fs.writeFile(path.join(workspace, 'chapter.literate'), '# SavedChapterMarker\n\n```text: <<probe.*>>= generated.txt $\nsaved generated body\n```\n');
    await fs.writeFile(path.join(workspace, 'generated.txt'), 'startup sentinel: must not be generated\n');
    await fs.writeFile(path.join(run, 'baseline.json'), JSON.stringify(await inventory(workspace), null, 2));
    await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ code, workspace, profile, port, manifest, ulem,
        runtime: '/usr/bin/node', browser: '/usr/bin/chromium-browser',
                mainSha256: createHash('sha256').update(await fs.readFile(path.join(project, 'out/main.js'))).digest('hex'),
                helperSha256: createHash('sha256').update(await fs.readFile(path.join(project, 'out/publication-helper.cjs'))).digest('hex') }, null, 2));
    console.log('M5_HOST_EVIDENCE', run);
    await runTests({ vscodeExecutablePath: code, extensionDevelopmentPath: project,
        extensionTestsPath: path.join(__dirname, 'publication-host.js'),
        extensionTestsEnv: { M5_HOST_RUN: run, M5_CDP_PORT: String(port),
            TEXINPUTS: `${path.dirname(ulem)}:${process.env.TEXINPUTS || ''}` },
        launchArgs: [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(run, 'extensions')}`,
            '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            '--no-sandbox', `--remote-debugging-port=${port}`] });
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
