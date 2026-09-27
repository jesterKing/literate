// Opt-in, installed VS Code only; no build/download/install or ordinary-profile changes.
// Run: node src/test/acceptance/language-host-run.js
// Required: LANGUAGE_HOST_TYPESCRIPT and LANGUAGE_HOST_ZLS (absolute executables).
// Optional: LANGUAGE_HOST_CODE, LANGUAGE_HOST_ZIG, LANGUAGE_HOST_TYPESCRIPT_ARGS (JSON array).
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { inventory } = require('./publication-host-run');
const project = path.resolve(__dirname, '../../..');
const fence = (header, body) => '```' + header + '\n' + body + '\n```\n';
async function main() {
    if (process.argv.includes('--child')) {
        const { runTests } = require('@vscode/test-electron');
        const run = process.env.LANGUAGE_HOST_RUN;
        const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
        await runTests({ vscodeExecutablePath: launch.code, extensionDevelopmentPath: project,
            extensionTestsPath: path.join(__dirname, 'language-host.js'),
            extensionTestsEnv: { LANGUAGE_HOST_RUN: run },
            launchArgs: [path.join(run, 'workspace'), `--user-data-dir=${path.join(run, 'profile')}`,
                `--extensions-dir=${path.join(run, 'extensions')}`, '--disable-extensions',
                '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox',
                                ...['vscode.git', 'vscode.git-base', 'vscode.github', 'vscode.markdown-language-features',
                                    'vscode.json-language-features', 'vscode.typescript-language-features', 'vscode.npm']
                                    .flatMap(id => ['--disable-extension', id])] });
        return;
    }
    const code = process.env.LANGUAGE_HOST_CODE || '/usr/share/code/code';
    const typescript = process.env.LANGUAGE_HOST_TYPESCRIPT;
    const zls = process.env.LANGUAGE_HOST_ZLS;
    if (!typescript || !zls) { throw new Error('Set LANGUAGE_HOST_TYPESCRIPT and LANGUAGE_HOST_ZLS to installed server executables'); }
    const zig = process.env.LANGUAGE_HOST_ZIG || '/usr/bin/zig';
    const args = JSON.parse(process.env.LANGUAGE_HOST_TYPESCRIPT_ARGS || '["--lsp","--stdio"]');
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) { throw new Error('Expected JSON string array for TypeScript args'); }
    for (const file of [code, typescript, zls, zig]) {
        if (!path.isAbsolute(file)) { throw new Error(`Executable must be absolute: ${file}`); }
        await fs.access(file, require('node:fs').constants.X_OK);
    }
    const main = await fs.readFile(path.join(project, 'out/main.js'));
    const run = await fs.mkdtemp(path.join(project, 'out/language-host-'));
    const workspace = path.join(run, 'workspace');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(run, 'profile/User'), { recursive: true });
    await fs.mkdir(path.join(run, 'extensions'));
    const servers = { typescript: { command: typescript, args }, zig: { command: zls, args: [], initializationOptions: { zig_exe_path: zig } } };
    await fs.writeFile(path.join(run, 'profile/User/settings.json'), JSON.stringify({
        'files.autoSave': 'off', 'files.hotExit': 'off', 'files.associations': { '*.literate': 'markdown' },
                'workbench.startupEditor': 'none', 'editor.snippetSuggestions': 'none',
                        'git.enabled': false, 'npm.autoDetect': 'off', 'task.autoDetect': 'off',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
        'telemetry.telemetryLevel': 'off', 'literate.languageServers': servers
    }, null, 2));
    const fixtures = {
        'index.literate': '# Language host acceptance\n\nProse must survive every source edit.\n\n'
            + fence('ts: <<main.*>>= main.ts $', '<<imports>>\n<<body>>')
            + fence(': <<imports>>=', 'import { physical } from "./physical";\nimport { aliased } from "@fixture/alias";\nimport { overlay } from "./overlay";')
            + fence(': <<body>>=', 'const local = { localMember: "local" };\nlocal.loc;\nphysical.phy;\naliased.ali;\noverlay.ove;\nconst localHover = local.localMember;\nconst physicalHover = physical.physicalMember;\nconst aliasHover = aliased.aliasMember;\nconst overlayHover = overlay.overlayMember;')
            + '\nTag completion stays available: <<body>>\n\n'
            + fence('zig: <<zig.*>>= main.zig $', '<<zig imports>>\n<<zig body>>')
            + fence(': <<zig imports>>=', 'const dep = @import("dep.zig");')
            + fence(': <<zig body>>=', 'pub fn main() void {\n    _ = dep.dep;\n    const zigHover = dep.dependencyValue;\n    _ = zigHover;\n}'),
        'dependency.literate': '# Overlay dependency\n\nNever materialize overlay.ts during language requests.\n\n'
            + fence('ts: <<overlay.*>>= overlay.ts $', '<<overlay body>>')
            + fence(': <<overlay body>>=', 'export const overlay = { overlayMember: "overlay" };'),
        'physical.ts': 'export const physical = { physicalMember: 123 };\n',
        'alias.ts': 'export const aliased = { aliasMember: true };\n',
        'dep.zig': 'pub const dependencyValue: u32 = 42;\n',
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@fixture/alias': ['./alias.ts'] } }, include: ['*.ts'] }, null, 2)
    };
    for (const [name, text] of Object.entries(fixtures)) { await fs.writeFile(path.join(workspace, name), text); }
    await fs.writeFile(path.join(run, 'baseline.json'), JSON.stringify(await inventory(workspace), null, 2));
    await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ code, servers, zig, mainSha256: createHash('sha256').update(main).digest('hex') }, null, 2));
    console.log('LANGUAGE_HOST_EVIDENCE', run);
    const child = spawn(process.execPath, [__filename, '--child'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANGUAGE_HOST_RUN: run } });
    let log = '', timedOut = false;
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', chunk => { log += chunk; process.stdout.write(chunk); }); }
    const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { throw error; } } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, 175000);
    let exit;
    try {
        exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    } finally {
        clearTimeout(timer); kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500)); kill('SIGKILL');
        await fs.writeFile(path.join(run, 'host.log'), log);
        await fs.writeFile(path.join(run, 'runner.json'), JSON.stringify({ ...exit, timedOut, cleanup: 'process group terminated; isolated profile/extensions removed; fixture and evidence retained' }, null, 2));
        await fs.rm(path.join(run, 'profile'), { recursive: true, force: true });
        await fs.rm(path.join(run, 'extensions'), { recursive: true, force: true });
    }
    if (timedOut || exit.code !== 0) { throw new Error(`Language host acceptance failed; see ${run} (timeout=${timedOut})`); }
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
