// Installed VS Code UI acceptance. Build separately with yarn esbuild; no downloads.
// Run: node src/test/acceptance/language-auto-host-run.js
// Required LANGUAGE_AUTO_HOST_TYPESCRIPT (absolute executable).
// Optional LANGUAGE_AUTO_HOST_CODE, LANGUAGE_AUTO_HOST_TYPESCRIPT_ARGS (JSON string array),
// LANGUAGE_AUTO_HOST_CDP_PORT, LANGUAGE_AUTO_HOST_EXTENSION (isolated built extension),
// LANGUAGE_AUTO_HOST_DIAGNOSTICS=false (preserve cold typing baseline with background diagnostics available).
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { inventory } = require('./publication-host-run');
const project = path.resolve(__dirname, '../../..');
async function main() {
    if (process.argv.includes('--child')) {
        const run = process.env.LANGUAGE_AUTO_HOST_RUN;
        const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
        await require('@vscode/test-electron').runTests({
            vscodeExecutablePath: launch.code, extensionDevelopmentPath: launch.extension || project,
            extensionTestsPath: path.join(__dirname, 'language-auto-host.js'),
            extensionTestsEnv: { LANGUAGE_AUTO_HOST_RUN: run },
            launchArgs: [path.join(run, 'workspace'), `--user-data-dir=${path.join(run, 'profile')}`,
                `--extensions-dir=${path.join(run, 'extensions')}`, `--remote-debugging-port=${launch.port}`,
                '--remote-debugging-address=127.0.0.1', '--disable-extensions', '--disable-workspace-trust',
                '--skip-welcome', '--skip-release-notes', '--no-sandbox',
                ...['vscode.git', 'vscode.git-base', 'vscode.github', 'vscode.markdown-language-features',
                    'vscode.json-language-features', 'vscode.typescript-language-features', 'vscode.npm']
                    .flatMap(id => ['--disable-extension', id])]
        });
        return;
    }
    const code = process.env.LANGUAGE_AUTO_HOST_CODE || '/usr/share/code/code';
    const command = process.env.LANGUAGE_AUTO_HOST_TYPESCRIPT;
    if (!command) { throw new Error('Set LANGUAGE_AUTO_HOST_TYPESCRIPT to an installed typescript-language-server executable'); }
    const args = JSON.parse(process.env.LANGUAGE_AUTO_HOST_TYPESCRIPT_ARGS || '["--stdio"]');
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) { throw new Error('Expected JSON string array for server args'); }
    for (const file of [code, command]) {
        if (!path.isAbsolute(file)) { throw new Error('Executable must be absolute: ' + file); }
        await fs.access(file, require('node:fs').constants.X_OK);
    }
    const port = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(Number(process.env.LANGUAGE_AUTO_HOST_CDP_PORT || 0), '127.0.0.1', () => {
            const selected = server.address().port;
            server.close(error => error ? reject(error) : resolve(selected));
        });
    });
    const extension = process.env.LANGUAGE_AUTO_HOST_EXTENSION || project;
        if (!path.isAbsolute(extension)) { throw new Error('LANGUAGE_AUTO_HOST_EXTENSION must be absolute'); }
        const diagnostics = process.env.LANGUAGE_AUTO_HOST_DIAGNOSTICS;
        if (diagnostics !== undefined && !['true', 'false'].includes(diagnostics)) { throw new Error('LANGUAGE_AUTO_HOST_DIAGNOSTICS must be true or false'); }
        const main = await fs.readFile(path.join(extension, 'out/main.js'));
    const run = await fs.mkdtemp(path.join(project, 'out/language-auto-host-'));
    const workspace = path.join(run, 'workspace');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(run, 'profile/User'), { recursive: true });
    await fs.mkdir(path.join(run, 'extensions'));
    const settings = {
        'files.autoSave': 'off', 'files.hotExit': 'off', 'files.associations': { '*.literate': 'markdown' },
        'workbench.startupEditor': 'none', 'workbench.editor.enablePreview': false,
        'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
        'editor.suggestOnTriggerCharacters': false, 'editor.wordBasedSuggestions': 'off',
        'editor.snippetSuggestions': 'none', 'editor.inlineSuggest.enabled': false,
        '[markdown]': { 'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' }, 'editor.suggestOnTriggerCharacters': false },
        'git.enabled': false, 'npm.autoDetect': 'off', 'task.autoDetect': 'off',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        ...(diagnostics === undefined ? {} : { 'literate.languageDiagnostics': diagnostics === 'true' }),
                'literate.languageServers': { typescript: { command, args, initializationOptions: { disableAutomaticTypingAcquisition: true } } }
    };
    await fs.writeFile(path.join(run, 'profile/User/settings.json'), JSON.stringify(settings, null, 2));
    const fence = (header, body) => '```' + header + '\n' + body + '\n```\n';
    const source = '# Automatic completion UI acceptance\n\nProse sentinel this\n\n'
        + fence('ts: <<main.*>>= main.ts $ template=wrapper.template', '<<body>>')
        + '\n' + fence(': <<body>>=', 'export class ListExample {\n    list: string[] = [];\n    constructor() {\n        this;\n    }\n    inspect() {\n        this;\n    }\n    // <<tag>>\n}')
        + '\n' + fence(': <<tag>>=', 'tag payload')
        + '\nTrailing prose sentinel.\n';
    const fixtures = {
        'index.literate': source, 'ordinary.md': source,
        'wrapper.template': '// Physical wrapper header\n// Offset source mappings by multiple lines\n\n[CODE]\n// Physical wrapper footer\n',
        'physical.ts': 'export const untouched = true;\n',
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Node' }, include: ['*.ts'] }, null, 2)
    };
    for (const [name, text] of Object.entries(fixtures)) { await fs.writeFile(path.join(workspace, name), text); }
    await fs.writeFile(path.join(run, 'baseline.json'), JSON.stringify(await inventory(workspace), null, 2));
    await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ code, port, command, args, settings, extension,
        mainSha256: createHash('sha256').update(main).digest('hex') }, null, 2));
    console.log('LANGUAGE_AUTO_HOST_EVIDENCE', run);
    const child = spawn(process.execPath, [__filename, '--child'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANGUAGE_AUTO_HOST_RUN: run } });
    let log = '', timedOut = false, exit;
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk; process.stdout.write(chunk); }); }
    const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, 195000);
    try {
        exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    } finally {
        clearTimeout(timer); kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500)); kill('SIGKILL');
        await fs.writeFile(path.join(run, 'host.log'), log);
        await fs.writeFile(path.join(run, 'runner.json'), JSON.stringify({ ...exit, timedOut,
            cleanup: 'Owned process group terminated; isolated profile/extensions removed; fixtures/evidence retained' }, null, 2));
        await fs.rm(path.join(run, 'profile'), { recursive: true, force: true });
        await fs.rm(path.join(run, 'extensions'), { recursive: true, force: true });
    }
    if (timedOut || exit.code !== 0) { throw new Error(`Automatic UI acceptance failed; see ${run} (timeout=${timedOut})`); }
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
