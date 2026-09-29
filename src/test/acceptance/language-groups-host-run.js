// Real installed VS Code, isolated source snapshot/build; never writes shared build artifacts.
// node src/test/acceptance/language-groups-host-run.js
// Optional LANGUAGE_GROUPS_CODE / TYPESCRIPT / CSS / HTML absolute executable overrides.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { inventory } = require('./publication-host-run');
const project = path.resolve(__dirname, '../../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const fence = (header, body) => '```' + header + '\n' + body + '\n```\n';
async function main() {
    if (process.argv.includes('--child')) {
        const run = process.env.LANGUAGE_GROUPS_RUN;
        const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
        await require('@vscode/test-electron').runTests({ vscodeExecutablePath: launch.code,
            extensionDevelopmentPath: path.join(run, 'extension'), extensionTestsPath: path.join(__dirname, 'language-groups-host.js'),
            extensionTestsEnv: { LANGUAGE_GROUPS_RUN: run },
            launchArgs: [path.join(run, 'workspace'), `--user-data-dir=${run}/profile`, `--extensions-dir=${run}/extensions`,
                            `--remote-debugging-port=${launch.port}`, '--remote-debugging-address=127.0.0.1',
                '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox',
                ...['vscode.git', 'vscode.git-base', 'vscode.github', 'vscode.markdown-language-features',
                    'vscode.json-language-features', 'vscode.typescript-language-features', 'vscode.html-language-features',
                    'vscode.css-language-features', 'vscode.npm'].flatMap(id => ['--disable-extension', id])] });
        return;
    }
    const code = process.env.LANGUAGE_GROUPS_CODE || '/usr/share/code/code';
    const servers = {
        typescript: { command: process.env.LANGUAGE_GROUPS_TYPESCRIPT || '/home/jesterking/.vscode/extensions/typescriptteam.native-preview-0.20260708.2-linux-arm64/lib/tsc', args: ['--lsp', '--stdio'] },
        css: { command: process.env.LANGUAGE_GROUPS_CSS || '/home/jesterking/.local/share/nvim/mason/bin/vscode-css-language-server', args: ['--stdio'],
                    configuration: { css: { validate: true, lint: { unknownProperties: 'warning' } } } },
        html: { command: process.env.LANGUAGE_GROUPS_HTML || '/home/jesterking/.local/share/nvim/mason/bin/vscode-html-language-server', args: ['--stdio'] }
    };
    for (const file of [code, ...Object.values(servers).map(s => s.command)]) {
        if (!path.isAbsolute(file)) { throw new Error('Expected absolute executable: ' + file); }
        await fs.access(file, require('node:fs').constants.X_OK);
    }
    const port = await new Promise((resolve, reject) => {
            const server = require('node:net').createServer(); server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
        });
        const run = await fs.mkdtemp(path.join(project, 'out/language-groups-host-'));
    const extension = path.join(run, 'extension'), workspace = path.join(run, 'workspace');
    for (const dir of [extension, workspace, 'profile/User', 'extensions'].map(p => path.isAbsolute(p) ? p : path.join(run, p))) {
        await fs.mkdir(dir, { recursive: true });
    }
    const controlledSource = await fs.readFile(path.join(__dirname, 'language-actions-server.js'));
    const controlledPath = path.join(run, 'language-actions-server.js');
    await fs.writeFile(controlledPath, controlledSource);
    const controlledCss = { command: process.execPath, args: [controlledPath] };
    // Copy a stable source snapshot. Abort rather than silently build across parallel edits.
    const sourceHashes = {};
    await fs.mkdir(path.join(extension, 'src'));
    for (const entry of await fs.readdir(path.join(project, 'src'), { withFileTypes: true })) {
        if (!entry.isFile()) { continue; }
        const source = await fs.readFile(path.join(project, 'src', entry.name));
        sourceHashes[entry.name] = hash(source);
        await fs.writeFile(path.join(extension, 'src', entry.name), source);
    }
    await fs.copyFile(path.join(project, 'package.json'), path.join(extension, 'package.json'));
    await fs.symlink(path.join(project, 'node_modules'), path.join(extension, 'node_modules'), 'dir');
    await require('esbuild').build({ entryPoints: [path.join(extension, 'src/extension.ts')], bundle: true,
        outfile: path.join(extension, 'out/main.js'), external: ['vscode'], format: 'cjs', platform: 'node', sourcemap: true });
    for (const [name, digest] of Object.entries(sourceHashes)) {
        if (hash(await fs.readFile(path.join(project, 'src', name))) !== digest) { throw new Error('Source changed during snapshot build: ' + name); }
    }
    const fixtures = {
        'index.literate': '# Groups 1–4\n\nProse sentinel.\n\n'
            + fence('ts: <<main.*>>= main.ts $ template=wrapper.template', '<<imports>>\n<<body>>')
            + fence(': <<imports>>=', 'import { physical } from "./physical";\nimport { overlay } from "./overlay";')
            + fence(': <<body>>=', '/** Render a greeting. */\nfunction greet(name: string, count: number): string { return name.repeat(count); }\nconst greeting = greet("Ada", 2);\ninterface Shape { size: number; }\nclass Square implements Shape { size = 4; }\nconst shape: Shape = new Square();\nconst size = shape.size;\nconst physicalUse = physical;\nconst overlayUse = overlay;\nconst members = {\n    /** Documented member. */\n    documentedMember: 1\n};\nmembers.doc;\nconst broken: number = "wrong";'),
        'dependency.literate': '# Dependency\n\n' + fence('ts: <<overlay.*>>= overlay.ts $', 'export const overlay = 42;'),
        'style.literate': '# CSS\n\n' + fence('css: <<style.*>>= style.css $', '<<css action body>>\n.color {\n    color: rg;\n}\n.sample {\n    dis\n}')
                    + '\nCSS action prose sentinel.\n\n' + fence('css: <<css action body>>=', '.typo {\n    colr: red;\n}'),
        'page.literate': '# HTML\n\n' + fence('html: <<page.*>>= generated-page.html $', '<div cl'),
        'wrapper.template': '// Header one\n// Header two\n\n[CODE]\n// Footer\n',
        'physical.ts': '/** Physical fixture. */\nexport const physical = 7;\n',
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] })
    };
    for (const [name, text] of Object.entries(fixtures)) { await fs.writeFile(path.join(workspace, name), text); }
    await fs.writeFile(path.join(run, 'profile/User/settings.json'), JSON.stringify({
        'files.autoSave': 'off', 'files.hotExit': 'off', 'files.associations': { '*.literate': 'markdown' },
        'workbench.startupEditor': 'none', 'git.enabled': false, 'npm.autoDetect': 'off', 'task.autoDetect': 'off',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
                'chat.disableAIFeatures': true,
        'telemetry.telemetryLevel': 'off', 'editor.snippetSuggestions': 'none',
                'editor.autoClosingBrackets': 'never', 'editor.autoClosingQuotes': 'never', 'literate.languageServers': servers
    }, null, 2));
    await fs.writeFile(path.join(run, 'baseline.json'), JSON.stringify(await inventory(workspace), null, 2));
    await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ code, port, servers, sourceHashes, controlledCss,
            controlledServerSha256: hash(controlledSource),
        mainSha256: hash(await fs.readFile(path.join(extension, 'out/main.js'))) }, null, 2));
    console.log('LANGUAGE_GROUPS_EVIDENCE', run);
    const child = spawn(process.execPath, [__filename, '--child'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANGUAGE_GROUPS_RUN: run } });
    let log = '', timedOut = false, exit;
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk; process.stdout.write(chunk); }); }
    const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, 210000);
    try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
    finally {
        clearTimeout(timer); kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 500)); kill('SIGKILL');
        await fs.writeFile(path.join(run, 'host.log'), log);
        await fs.writeFile(path.join(run, 'runner.json'), JSON.stringify({ ...exit, timedOut, cleanup: 'Owned process group killed; isolated profile/extensions removed' }, null, 2));
        await fs.rm(path.join(run, 'profile'), { recursive: true, force: true });
        await fs.rm(path.join(run, 'extensions'), { recursive: true, force: true });
    }
    if (timedOut || exit.code !== 0) { throw new Error('Groups acceptance failed: ' + run); }
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
