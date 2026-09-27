import assert = require('node:assert/strict');
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
    compilePdf, createPdfCompiler, PdfCompilationError, PdfCompiler,
    PdfProcessRequest, PdfProcessRunner, runPdfProcess
} from '../../publication-pdf';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
const files = [{ path: 'output/-draft $name.tex', content: 'trusted TeX' },
    { path: 'output/assets/picture.png', content: new Uint8Array([1, 2, 3]) }];
const entry = files[0].path;
const required = ['scrbook.cls', 'fontspec.sty', 'geometry.sty', 'fvextra.sty', 'needspace.sty',
    'xcolor.sty', 'microtype.sty', 'amssymb.sty', 'amsmath.sty', 'graphicx.sty', 'ulem.sty', 'hyperref.sty'];

test('caller cancellation survives lazy compiler loading before any tool starts', async () => {
    const compiler = createPdfCompiler(async () => assert.fail('no tool may start'));
    await assert.rejects(compiler(files, entry, { checkCancelled() {
        throw new Error('caller cancelled before import completed');
    } }), /caller cancelled before import completed/);
});

type Build = (request: PdfProcessRequest) => Promise<{ code: number | null; output: string }>;
function fixture(build?: Build) {
    const calls: PdfProcessRequest[] = [];
    const runner: PdfProcessRunner = async request => {
        calls.push(request);
        if (request.args.includes('--version')) { return { code: 0, output: 'installed' }; }
        if (request.command === 'kpsewhich') { return { code: 0, output: '/tex/' + request.args[1] }; }
        if (build) { return build(request); }
        await artifacts(request.cwd);
        return { code: 0, output: 'done' };
    };
    return { calls, runner, compile: createPdfCompiler(runner) };
}
async function artifacts(cwd: string, log = '', bytes = pdf): Promise<void> {
    await fs.writeFile(path.join(cwd, 'book.log'), log);
    await fs.writeFile(path.join(cwd, 'book.pdf'), bytes);
}
async function absent(filename: string): Promise<void> {
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
}
async function failure(action: Promise<unknown>): Promise<PdfCompilationError> {
    try { await action; }
    catch (error) { assert.ok(error instanceof PdfCompilationError); return error; }
    assert.fail('Expected PdfCompilationError');
}

test('PDF API stages companions, fixes entry basename, and cleans successful builds', async () => {
    const publicCompiler: PdfCompiler = compilePdf;
    assert.equal(typeof publicCompiler, 'function');
    const fake = fixture(async request => {
        assert.equal(await fs.readFile(path.join(request.cwd, 'book.tex'), 'utf8'), 'trusted TeX');
        assert.deepEqual(await fs.readFile(path.join(request.cwd, 'assets/picture.png')), Buffer.from([1, 2, 3]));
        await absent(path.join(request.cwd, path.posix.basename(entry)));
        if (process.platform !== 'win32') {
            assert.equal((await fs.stat(path.dirname(request.cwd))).mode & 0o777, 0o700);
        }
        await artifacts(request.cwd);
        return { code: 0, output: 'done' };
    });
    const result = await fake.compile(files, entry);
    assert.deepEqual(result.pdf, pdf);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.buildDirectory, undefined);
    await absent(path.dirname(fake.calls[0].cwd));
    assert.equal(files[0].path, entry);
    assert.deepEqual(files[1].content, new Uint8Array([1, 2, 3]));
});

test('PDF preflight checks template dependencies and uses literal bounded build flags', async () => {
    const fake = fixture();
    await fake.compile(files, entry);
    assert.deepEqual(fake.calls.slice(0, 3).map(call => [call.command, call.args]), [
        ['latexmk', ['-norc', '--version']], ['lualatex', ['--version']], ['kpsewhich', ['--version']]
    ]);
    assert.deepEqual(fake.calls.slice(3, -1).map(call => call.args),
        required.map(file => ['-progname=lualatex', file]));
    const build = fake.calls[fake.calls.length - 1];
    assert.equal(build.command, 'latexmk');
    assert.deepEqual(build.args, ['-norc', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
        '-file-line-error', '-no-shell-escape', '-e', '$max_repeat = 5;', 'book.tex']);
    assert.equal(build.timeoutMs, 180_000);
    assert.equal(build.maximumOutputBytes, 4 * 1024 * 1024);
    assert.equal(build.env.TEXMFOUTPUT, path.dirname(build.cwd));
    assert.ok(build.env.TEXMFVAR?.startsWith(path.dirname(build.cwd) + path.sep));
    assert.equal(build.env.TEXMFCACHE, build.env.TEXMFVAR);
    assert.equal(build.env.TEXMFHOME, process.env.TEXMFHOME);
    assert.equal(build.env.TEXINPUTS, process.env.TEXINPUTS);
    assert.equal(build.env.SOURCE_DATE_EPOCH, process.env.SOURCE_DATE_EPOCH);
    assert.equal(build.env.shell_escape, 'f');
});

test('PDF keepBuild transfers ownership on success', async () => {
    const fake = fixture();
    const result = await fake.compile(files, entry, { keepBuild: true });
    assert.ok(result.buildDirectory);
    try {
        assert.equal(result.buildDirectory, path.dirname(fake.calls[0].cwd));
        assert.deepEqual(await fs.readFile(path.join(result.buildDirectory, 'output/book.pdf')), pdf);
    } finally { await fs.rm(result.buildDirectory, { recursive: true, force: true }); }
});

for (const keepBuild of [false, true]) {
    test(`PDF failure retains warnings and obeys keepBuild=${keepBuild}`, async () => {
        const fake = fixture(async request => {
            await artifacts(request.cwd, 'Missing character: There is no X in font Y!\nOverfull \\hbox (2pt too wide)');
            return { code: 1, output: 'intentional engine failure' };
        });
        const error = await failure(fake.compile(files, entry, { keepBuild }));
        const directory = path.dirname(fake.calls[0].cwd);
        assert.match(error.message, /latexmk failed.*exit 1[\s\S]*intentional engine failure/);
        assert.equal(error.warnings.length, 2);
        assert.equal(error.buildDirectory, keepBuild ? directory : undefined);
        if (keepBuild) {
            try { assert.ok((await fs.stat(directory)).isDirectory()); }
            finally { await fs.rm(directory, { recursive: true, force: true }); }
        } else { await absent(directory); }
    });
}

test('PDF missing tools are actionable, retain stage when requested, and never build', async () => {
    const calls: PdfProcessRequest[] = [];
    const compiler = createPdfCompiler(async request => {
        calls.push(request);
        throw new Error('spawn ENOENT');
    });
    const error = await failure(compiler(files, entry, { keepBuild: true }));
    assert.match(error.message, /Cannot run latexmk.*Install a TeX distribution.*PATH/);
    assert.equal(calls.length, 1);
    assert.ok(error.buildDirectory);
    try { assert.ok((await fs.stat(error.buildDirectory)).isDirectory()); }
    finally { await fs.rm(error.buildDirectory, { recursive: true, force: true }); }
});

test('PDF missing packages are enumerated and fail before compilation', async () => {
    const fake = fixture();
    const compiler = createPdfCompiler(request => request.command === 'kpsewhich' &&
        ['fontspec.sty', 'fvextra.sty'].includes(request.args[1])
        ? Promise.resolve({ code: 1, output: '' }) : fake.runner(request));
    const error = await failure(compiler(files, entry));
    assert.match(error.message, /Missing TeX packages: fontspec.sty, fvextra.sty.*package manager/);
    assert.equal(fake.calls.some(call => call.args.includes('-lualatex')), false);
    await absent(path.dirname(fake.calls[0].cwd));
});

for (const invalid of ['/tmp/book.tex', '../book.tex', 'a/../book.tex', 'a//book.tex',
    './book.tex', 'C:/book.tex', 'a\\book.tex', 'a\u0000.tex', 'a\n.tex', 'CON.tex', 'a./book.tex']) {
    test(`PDF rejects unsafe entry ${JSON.stringify(invalid)} before tools run`, async () => {
        const fake = fixture();
        const error = await failure(fake.compile([{ path: invalid, content: '' }], invalid));
        assert.match(error.message, /Unsafe publication path/);
        assert.equal(error.buildDirectory, undefined);
        assert.equal(fake.calls.length, 0);
    });
}

test('PDF rejects missing/non-TeX entries, unsafe companions, duplicates, and seeded artifacts', async () => {
    const cases: { files: Parameters<PdfCompiler>[0]; entry: string }[] = [
        { files: [], entry: 'book.tex' },
        { files: [{ path: 'book.txt', content: '' }], entry: 'book.txt' },
        { files: [...files, { path: '../escape', content: '' }], entry },
        { files: [...files, files[0]], entry },
        { files: [...files, { path: 'OUTPUT/assets/PICTURE.png', content: '' }], entry },
        { files: [...files, { path: 'output/book.pdf', content: pdf }], entry },
        { files: [...files, { path: 'output/book.log', content: '' }], entry },
        { files: [...files, { path: 'output/book.tex', content: '' }], entry }
    ];
    for (const item of cases) {
        const fake = fixture();
        await failure(fake.compile(item.files, item.entry));
        assert.equal(fake.calls.length, 0);
    }
});

test('PDF staging failures retain the partial stage only when requested', async () => {
    const fake = fixture();
    const error = await failure(fake.compile([{ path: 'book.tex', content: '' },
        { path: 'asset', content: '' }, { path: 'asset/child', content: '' }], 'book.tex', { keepBuild: true }));
    assert.equal(fake.calls.length, 0);
    assert.ok(error.buildDirectory);
    try { assert.equal(await fs.readFile(path.join(error.buildDirectory, 'book.tex'), 'utf8'), ''); }
    finally { await fs.rm(error.buildDirectory, { recursive: true, force: true }); }
});

for (const log of ['LaTeX Warning: There were undefined references.',
    "LaTeX Warning: Reference `missing' on page 1 undefined on input line 2.",
    'LaTeX Warning: There were undefined citations.', 'LaTeX Warning: Label(s) may have changed.',
    'Package rerunfilecheck Warning: File book.out has changed.',
    'Package biblatex Warning: Please (re)run Biber on the file: book',
    'LaTeX Warning: There were undefined\nreferences.',
    'LaTeX Warning:\nThere were undefined references.',
    "LaTeX Warning: Reference `a-very-long-label' on page 12\nundefined on input line 87.",
    "Package natbib Warning: Citation `missing' on page 1\n(natbib)                undefined on input line 2.",
    'LaTeX Warning: Label(s) may have\n               changed. Rerun to get cross-references right.',
    'Package biblatex Warning: Please (re)run\n(biblatex)                Biber on the file:\n(biblatex)                book',
    "Package rerunfilecheck Warning: File `book.out' has\n(rerunfilecheck)                changed."]) {
    test(`PDF rejects nominal success with ${log}`, async () => {
        const fake = fixture(async request => {
            await artifacts(request.cwd, log);
            return { code: 0, output: '' };
        });
        assert.match((await failure(fake.compile(files, entry))).message, /did not converge/);
        await absent(path.dirname(fake.calls[0].cwd));
    });
}

test('PDF accepts earlier unresolved passes but rejects exhausted latexmk repeats', async () => {
    const transcripts = [
        'LaTeX Warning: There were undefined references.\nSecond pass succeeded.',
        'Latexmk: Maximum runs of lualatex reached without getting stable files',
        'Latexmk: Maximum runs of lualatex reached\n  without getting stable files',
        "Latexmk: Failure in processing file 'book.tex':\n   'lualatex' needed too many passes"
    ];
    for (const [index, output] of transcripts.entries()) {
        const fake = fixture(async request => {
            await artifacts(request.cwd);
            return { code: 0, output };
        });
        if (index) { assert.match((await failure(fake.compile(files, entry))).message, /did not converge/); }
        else { assert.deepEqual((await fake.compile(files, entry)).pdf, pdf); }
    }
});

for (const log of [
    'Overfull \\hbox (1pt too wide) in paragraph at lines 10--12\n[]\\TU/font We discuss undefined references and too many passes here.\n',
    'undefined references\ntoo many passes\nfailed to converge\nPlease (re)run Biber\n',
    'Package example Warning: Ordinary informational warning.\n\nOverfull \\hbox (2pt too wide)\nundefined references\n',
    'Package example Warning: Ordinary informational warning.\nOverfull \\hbox (2pt too wide)\nReference x undefined\n',
    'Package rerunfilecheck Warning: An unrelated informational warning.',
    'LaTeX Font Warning: Font shape unavailable; too many passes is ordinary quoted prose.'
]) {
    test(`PDF convergence ignores benign diagnostic text ${JSON.stringify(log)}`, async () => {
        const fake = fixture(async request => {
            await artifacts(request.cwd, log);
            return { code: 0, output: log };
        });
        assert.deepEqual((await fake.compile(files, entry)).pdf, pdf);
    });
}

test('PDF retains missing glyph and overfull warnings without failing', async () => {
    const warning = 'Missing character: There is no X in font Y!';
    const fake = fixture(async request => {
        await artifacts(request.cwd, `${warning}\nOverfull \\hbox (1pt too wide)\n${warning}\nOverfull \\vbox (2pt too high)`);
        return { code: 0, output: '' };
    });
    assert.deepEqual((await fake.compile(files, entry)).warnings,
        [warning, 'Overfull \\hbox (1pt too wide)', 'Overfull \\vbox (2pt too high)']);
});

for (const kind of ['missing-pdf', 'empty', 'bad-header', 'directory', 'symlink', 'hardlink',
    'large-pdf', 'missing-log', 'large-log', 'linked-log']) {
    test(`PDF rejects ${kind} output and cleans the stage`,
        { skip: process.platform === 'win32' && ['symlink', 'linked-log'].includes(kind) }, async () => {
        const fake = fixture(async request => {
            await artifacts(request.cwd);
            const filename = path.join(request.cwd, 'book.pdf');
            const log = path.join(request.cwd, 'book.log');
            if (kind === 'missing-pdf') { await fs.unlink(filename); }
            if (kind === 'empty') { await fs.writeFile(filename, ''); }
            if (kind === 'bad-header') { await fs.writeFile(filename, 'not a PDF file'); }
            if (kind === 'directory') { await fs.unlink(filename); await fs.mkdir(filename); }
            if (kind === 'symlink' || kind === 'hardlink') {
                await fs.rename(filename, path.join(request.cwd, 'other.pdf'));
                if (kind === 'symlink') { await fs.symlink('other.pdf', filename); }
                else { await fs.link(path.join(request.cwd, 'other.pdf'), filename); }
            }
            if (kind === 'large-pdf') { await fs.truncate(filename, 64 * 1024 * 1024 + 1); }
            if (kind === 'missing-log') { await fs.unlink(log); }
            if (kind === 'large-log') { await fs.truncate(log, 4 * 1024 * 1024 + 1); }
            if (kind === 'linked-log') { await fs.unlink(log); await fs.symlink('book.tex', log); }
            return { code: 0, output: '' };
        });
        await failure(fake.compile(files, entry));
        await absent(path.dirname(fake.calls[0].cwd));
    });
}

test('PDF injected runner rejection still cleans staging', async () => {
    const fake = fixture(async () => { throw new Error('build timed out'); });
    assert.match((await failure(fake.compile(files, entry))).message, /build timed out/);
    await absent(path.dirname(fake.calls[0].cwd));
});

test('PDF compiler removes lifetime hooks after both success and failure', async () => {
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = events.map(event => process.listenerCount(event));
    await fixture().compile(files, entry);
    assert.deepEqual(events.map(event => process.listenerCount(event)), before);
    const fake = fixture(async () => { throw new Error('failed'); });
    await failure(fake.compile(files, entry));
    assert.deepEqual(events.map(event => process.listenerCount(event)), before);
});

function tempEnvironment(directory: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) { env[name] = directory; }
    return env;
}

function nodeRequest(script: string, cwd: string, overrides: Partial<PdfProcessRequest> = {}): PdfProcessRequest {
    return { command: process.execPath, args: ['-e', script], cwd, env: { ...process.env },
        timeoutMs: 5000, maximumOutputBytes: 4096, ...overrides };
}

test('PDF process runner drains both streams and removes lifecycle hooks',
    { skip: process.platform === 'win32' }, async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-runner-'));
    const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = events.map(event => process.listenerCount(event));
    try {
        const result = await runPdfProcess(nodeRequest(
            'process.stdout.write("stdout"); process.stderr.write("stderr"); process.exitCode = 3;', directory));
        assert.equal(result.code, 3);
        assert.match(result.output, /stdout/);
        assert.match(result.output, /stderr/);
        assert.deepEqual(events.map(event => process.listenerCount(event)), before);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('PDF process runner bounds runtime, output, and handles missing executables',
    { skip: process.platform === 'win32' }, async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-runner-'));
    try {
        await assert.rejects(runPdfProcess(nodeRequest('setInterval(() => {}, 1000)', directory,
            { timeoutMs: 100 })), /timed out/);
        await assert.rejects(runPdfProcess(nodeRequest('process.stdout.write("x".repeat(10000))', directory,
            { maximumOutputBytes: 100 })), error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /output limit/);
            assert.ok(error.message.length < 300);
            return true;
        });
        await assert.rejects(runPdfProcess(nodeRequest('', directory,
            { command: path.join(directory, 'nonexistent-executable') })), /ENOENT/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

for (const timeout of [false, true]) {
    test(`PDF POSIX runner kills descendants on ${timeout ? 'timeout' : 'leader exit'}`,
        { skip: process.platform === 'win32' }, async () => {
            const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-runner-'));
            const marker = path.join(directory, 'escaped');
            const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 1500);`;
            const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], ` +
                `{stdio: 'inherit'}); ${timeout ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 100);'}`;
            try {
                const action = runPdfProcess(nodeRequest(script, directory, { timeoutMs: timeout ? 500 : 5000 }));
                if (timeout) { await assert.rejects(action, /timed out/); }
                else { assert.equal((await action).code, 0); }
                await new Promise(resolve => setTimeout(resolve, 1700));
                await absent(marker);
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`PDF runner cancels on ${signal} without leaving detached descendants`,
        { skip: process.platform === 'win32' }, async () => {
            const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-signal-'));
            const marker = path.join(directory, 'escaped');
            const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 1500);`;
            const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], ` +
                `{stdio: 'inherit'}); setInterval(() => {}, 1000);`;
            const modulePath = path.resolve(__dirname, '../../publication-pdf');
            const script = `const {runPdfProcess} = require(${JSON.stringify(modulePath)}); ` +
                `runPdfProcess(${JSON.stringify(nodeRequest(leader, directory))}).then(` +
                `() => { process.exitCode = 1; }, error => { process.stdout.write(error.message); }); ` +
                `setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 500);`;
            try {
                const result = await runPdfProcess(nodeRequest(script, directory));
                assert.equal(result.code, 0);
                assert.match(result.output, new RegExp(`interrupted by ${signal}`));
                await new Promise(resolve => setTimeout(resolve, 1700));
                await absent(marker);
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        });
}

// Hooks live in a subprocess: neither fs patches nor actual signals affect the test host.
function compilerSignalScript(phase: string, signal: string, keepBuild: boolean): string {
    const modulePath = path.resolve(__dirname, '../../publication-pdf');
    return `
        const assert = require('node:assert/strict');
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const real = { ...fs };
        const phase = ${JSON.stringify(phase)}, signal = ${JSON.stringify(signal)};
        const keepBuild = ${JSON.stringify(keepBuild)};
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        const before = signals.map(name => process.listenerCount(name));
        let stage, interrupted = false, calls = 0, laterWrites = 0, pdfReads = 0, closed = 0, cleanups = 0;
        const send = async name => {
            process.kill(process.pid, name);
            await new Promise(resolve => setTimeout(resolve, 20));
        };
        const interrupt = async () => {
            if (!interrupted) { interrupted = true; await send(signal); }
        };
        fs.mkdtemp = async (...args) => {
            const directory = await real.mkdtemp(...args);
            if (!stage) {
                stage = directory;
                if (phase === 'mkdtemp') { await interrupt(); }
            }
            return directory;
        };
        fs.writeFile = async (...args) => {
            if (path.basename(args[0]) === 'later.txt') { laterWrites++; }
            await real.writeFile(...args);
            if (phase === 'staging' && path.basename(args[0]) === 'book.tex') { await interrupt(); }
        };
        fs.open = async (...args) => {
            const handle = await real.open(...args);
            const read = handle.read.bind(handle), close = handle.close.bind(handle);
            handle.read = async (...readArgs) => {
                const result = await read(...readArgs);
                if (path.basename(args[0]) === 'book.pdf') { pdfReads++; }
                if (path.basename(args[0]) === 'book.' + phase) { await interrupt(); }
                return result;
            };
            handle.close = async () => { closed++; await close(); };
            return handle;
        };
        fs.rm = async (...args) => {
            if (args[0] === stage) {
                cleanups++;
                if (phase === 'cleanup') { await interrupt(); }
                if (interrupted) { await send('SIGTERM'); await send('SIGHUP'); }
            }
            return real.rm(...args);
        };
        const {createPdfCompiler, PdfCompilationError} = require(${JSON.stringify(modulePath)});
        const compiler = createPdfCompiler(async request => {
            calls++;
            if (request.args.includes('--version')) { return {code: 0, output: 'installed'}; }
            if (request.command === 'kpsewhich') { return {code: 0, output: '/tex/package'}; }
            await real.writeFile(path.join(request.cwd, 'book.log'), 'Missing character: fixture warning');
            await real.writeFile(path.join(request.cwd, 'book.pdf'), '%PDF-1.7\\nfixture\\n');
            return {code: 0, output: ''};
        });
        (async () => {
            let failure;
            try {
                await compiler([{path: 'book.tex', content: ''}, {path: 'later.txt', content: ''}],
                    'book.tex', {keepBuild});
            } catch (error) { failure = error; }
            assert.ok(failure instanceof PdfCompilationError, 'cancellation must never return success');
            assert.match(failure.message, new RegExp('interrupted by ' + signal));
            assert.equal(interrupted, true);
            assert.deepEqual(signals.map(name => process.listenerCount(name)), before);
            if (phase === 'mkdtemp' || phase === 'staging') {
                assert.equal(calls, 0, 'cancellation must prevent all tool calls');
                assert.equal(laterWrites, 0, 'cancellation must prevent subsequent staged writes');
            }
            if (phase === 'log') { assert.equal(pdfReads, 0, 'cancelled log read must prevent PDF read'); }
            if (phase === 'log' || phase === 'pdf') {
                assert.ok(closed > 0, 'cancelled reads must still close their handles');
                assert.deepEqual(failure.warnings, ['Missing character: fixture warning']);
            }
            assert.equal(cleanups, keepBuild ? 0 : 1);
            assert.equal(failure.buildDirectory, keepBuild ? stage : undefined);
            if (keepBuild) { assert.ok((await real.stat(stage)).isDirectory()); }
            else { await assert.rejects(real.stat(stage), {code: 'ENOENT'}); }
        })().catch(error => { console.error(error); process.exitCode = 1; })
            .finally(async () => { if (stage) { await real.rm(stage, {recursive: true, force: true}); } });
    `;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    for (const phase of ['mkdtemp', 'staging', 'log', 'pdf', 'cleanup']) {
        test(`PDF compiler cancels during ${phase} on ${signal} and survives repeated cleanup signals`,
            { skip: process.platform === 'win32' }, async () => {
                const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-lifetime-test-'));
                try {
                    execFileSync(process.execPath, ['-e', compilerSignalScript(phase, signal, false)], {
                        timeout: 10_000, env: tempEnvironment(directory)
                    });
                } finally { await fs.rm(directory, { recursive: true, force: true }); }
            });
    }
}

for (const phase of ['staging', 'pdf']) {
    test(`PDF compiler cancellation during ${phase} honors keepBuild`,
        { skip: process.platform === 'win32' }, async () => {
            const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-lifetime-test-'));
            try {
                execFileSync(process.execPath, ['-e', compilerSignalScript(phase, 'SIGINT', true)], {
                    timeout: 10_000, env: tempEnvironment(directory)
                });
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        });
}

test('PDF default runner explicitly rejects Windows while injected compilation remains available', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-windows-test-'));
    const modulePath = path.resolve(__dirname, '../../publication-pdf');
    const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const {runPdfProcess, createPdfCompiler} = require(${JSON.stringify(modulePath)});
        Object.defineProperty(process, 'platform', {value: 'win32'});
        (async () => {
            await assert.rejects(runPdfProcess(${JSON.stringify(nodeRequest('', directory))}),
                /unsupported on Windows.*process-tree-safe termination/);
            const compiler = createPdfCompiler(async request => {
                if (request.args.includes('--version')) { return {code: 0, output: 'installed'}; }
                if (request.command === 'kpsewhich') { return {code: 0, output: '/tex/package'}; }
                await fs.writeFile(path.join(request.cwd, 'book.log'), '');
                await fs.writeFile(path.join(request.cwd, 'book.pdf'), '%PDF-1.7\\nfixture');
                return {code: 0, output: ''};
            });
            const result = await compiler([{path: 'book.tex', content: ''}], 'book.tex');
            assert.ok(result.pdf.length > 8);
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    try {
        execFileSync(process.execPath, ['-e', script], {
            timeout: 10_000, env: tempEnvironment(directory)
        });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
