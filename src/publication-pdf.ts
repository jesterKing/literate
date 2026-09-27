import { spawn, ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
export interface PdfCompileOptions { keepBuild?: boolean; checkCancelled?: () => void; }
export interface PdfCompilation {
    pdf: Uint8Array;
    warnings: string[];
    buildDirectory?: string;
}
export type PdfCompiler = (files: readonly { path: string; content: string | Uint8Array }[],
    entry: string, options?: PdfCompileOptions) => Promise<PdfCompilation>;
export class PdfCompilationError extends Error {
    constructor(message: string, public readonly buildDirectory?: string,
        public readonly warnings: string[] = []) {
        super(message);
        this.name = 'PdfCompilationError';
    }
}
export interface PdfProcessRequest {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maximumOutputBytes: number;
}
export interface PdfProcessResult { code: number | null; output: string; }
export type PdfProcessRunner = (request: PdfProcessRequest) => Promise<PdfProcessResult>;
const maximumLogBytes = 4 * 1024 * 1024;
const maximumPdfBytes = 64 * 1024 * 1024;
const buildTimeoutMs = 180_000;
function killProcessTree(child: ChildProcess): void {
    if (!child.pid) { return; }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            try { child.kill('SIGKILL'); } catch { /* The process may already be gone. */ }
        }
    }
}
interface ProcessCapture {
    chunks: Buffer[]; bytes: number; failure?: Error;
    drainTimer?: NodeJS.Timeout;
}
export const runPdfProcess: PdfProcessRunner = request => new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
        reject(new Error('PDF compilation is unsupported on Windows: process-tree-safe termination is unavailable'));
        return;
    }
    const child = spawn(request.command, [...request.args], {
        cwd: request.cwd, env: request.env, shell: false,
        detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const capture: ProcessCapture = { chunks: [], bytes: 0 };
    const stop = (error?: Error) => {
        capture.failure ??= error;
        killProcessTree(child);
        capture.drainTimer ??= setTimeout(() => {
            child.stdout?.destroy(); child.stderr?.destroy();
        }, 1000);
    };
    const timer = setTimeout(() => stop(new Error(
        `${request.command} timed out after ${request.timeoutMs} ms`)), request.timeoutMs);
    const cleanup = processHooks(child, stop);
    captureProcess(child, request, capture, stop);
    finishProcess(child, capture, timer, cleanup, resolve, reject);
});
function captureProcess(child: ChildProcess, request: PdfProcessRequest,
    capture: ProcessCapture, stop: (error?: Error) => void): void {
    const data = (chunk: Buffer) => {
        const remaining = Math.max(0, request.maximumOutputBytes - capture.bytes);
        if (remaining) { capture.chunks.push(chunk.subarray(0, remaining)); }
        capture.bytes += chunk.length;
        if (capture.bytes > request.maximumOutputBytes) {
            stop(new Error(`${request.command} exceeded its output limit`));
        }
    };
    for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', data);
        stream?.on('error', stop);
    }
    child.once('error', error => stop(error));
    child.once('exit', () => stop());
}
function processHooks(child: ChildProcess, stop: (error?: Error) => void): () => void {
    const exit = () => killProcessTree(child);
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = signals.map(signal => () => stop(new Error(`PDF compilation interrupted by ${signal}`)));
    process.on('exit', exit);
    signals.forEach((signal, index) => process.on(signal, handlers[index]));
    return () => {
        process.removeListener('exit', exit);
        signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    };
}
function finishProcess(child: ChildProcess, capture: ProcessCapture, timer: NodeJS.Timeout,
    cleanup: () => void, resolve: (result: PdfProcessResult) => void, reject: (error: Error) => void): void {
    child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(capture.drainTimer); cleanup();
        const output = Buffer.concat(capture.chunks).toString('utf8');
        const failure = capture.failure ?? (signal ? new Error(`Process terminated by ${signal}`) : undefined);
        if (failure) { reject(new Error(`${failure.message}\n${output}`.trim())); }
        else { resolve({ code, output }); }
    });
}
function compilerLifetime(): { check: () => void; dispose: () => void } {
    let cancellation: Error | undefined;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = signals.map(signal => () => {
        cancellation ??= new Error(`PDF compilation interrupted by ${signal}`);
    });
    signals.forEach((signal, index) => process.on(signal, handlers[index]));
    return {
        check: () => { if (cancellation) { throw cancellation; } },
        dispose: () => signals.forEach((signal, index) => process.removeListener(signal, handlers[index]))
    };
}
function checkedRunner(runner: PdfProcessRunner, check: () => void): PdfProcessRunner {
    return async request => {
        check();
        const result = await runner(request);
        check();
        return result;
    };
}
function safePlanPath(value: string): string {
    if (!value || /[\\:\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') ||
        value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error(`Unsafe publication path: ${JSON.stringify(value)}`);
    }
    return value;
}
function prepareFiles(files: Parameters<PdfCompiler>[0], entry: string): Parameters<PdfCompiler>[0] {
    safePlanPath(entry);
    if (!entry.endsWith('.tex')) { throw new Error('PDF entry must be a .tex path'); }
    const fixed = path.posix.join(path.posix.dirname(entry), 'book.tex');
    const seen = new Set<string>();
    const prepared = files.map(file => {
        const name = safePlanPath(file.path);
        const staged = name === entry ? fixed : name;
        if (seen.has(staged.toLowerCase()) || (name !== entry &&
            path.posix.dirname(name).toLowerCase() === path.posix.dirname(entry).toLowerCase() &&
            /^book\./i.test(path.posix.basename(name)))) { throw new Error(`Conflicting publication path: ${name}`); }
        seen.add(staged.toLowerCase());
        return { path: staged, content: file.content };
    });
    if (!files.some(file => file.path === entry)) { throw new Error(`Missing PDF entry: ${entry}`); }
    return prepared;
}
async function stageFiles(directory: string, files: Parameters<PdfCompiler>[0], check: () => void): Promise<void> {
    check();
    await fs.chmod(directory, 0o700);
    for (const file of files) {
        check();
        const destination = path.join(directory, ...file.path.split('/'));
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        check();
        await fs.writeFile(destination, file.content, { flag: 'wx', mode: 0o600 });
    }
    check();
}
async function buildEnvironment(directory: string): Promise<NodeJS.ProcessEnv> {
    const cache = await fs.mkdtemp(path.join(directory, '.tex-cache-'));
    return { ...process.env, TEXMFOUTPUT: directory, TEXMFVAR: cache, TEXMFCACHE: cache,
        openout_any: 'p', shell_escape: 'f' };
}
function requestFor(command: string, args: readonly string[], cwd: string,
    env: NodeJS.ProcessEnv, timeoutMs = 15_000): PdfProcessRequest {
    return { command, args, cwd, env, timeoutMs, maximumOutputBytes: maximumLogBytes };
}
const requiredTexFiles = [
    'scrbook.cls', 'fontspec.sty', 'geometry.sty', 'fvextra.sty', 'needspace.sty',
    'xcolor.sty', 'microtype.sty', 'amssymb.sty', 'amsmath.sty', 'graphicx.sty',
    'ulem.sty', 'hyperref.sty'
];
async function preflight(runner: PdfProcessRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    for (const command of ['latexmk', 'lualatex', 'kpsewhich']) {
        try {
            const args = command === 'latexmk' ? ['-norc', '--version'] : ['--version'];
            const result = await runner(requestFor(command, args, cwd, env));
            if (result.code !== 0) { throw new Error(result.output || `exit ${result.code}`); }
        } catch (error) {
            throw new Error(`Cannot run ${command}. Install a TeX distribution with latexmk and LuaLaTeX, ` +
                `and ensure ${command} is on PATH. ${errorMessage(error)}`);
        }
    }
    const missing: string[] = [];
    for (const file of requiredTexFiles) {
        const result = await runner(requestFor('kpsewhich', ['-progname=lualatex', file], cwd, env));
        if (result.code !== 0 || !result.output.trim()) { missing.push(file); }
    }
    if (missing.length) { throw new Error(`Missing TeX packages: ${missing.join(', ')}. ` +
        'Install these using your TeX distribution package manager, then retry.'); }
}
async function readBoundedFile(filename: string, limit: number, check: () => void = () => {}): Promise<Buffer> {
    check(); const before = await fs.lstat(filename);
    check();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error(`Expected a regular nonlink file: ${path.basename(filename)}`);
    }
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0));
    try {
        check(); const stat = await handle.stat();
        check();
        if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev ||
            stat.size > limit) { throw new Error(`Invalid or oversized compiler file: ${path.basename(filename)}`); }
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
            check(); const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) { break; }
            length += read.bytesRead;
        }
        if (length !== stat.size) { throw new Error(`Compiler file changed while reading: ${path.basename(filename)}`); }
        check(); return buffer.subarray(0, length);
    } finally { await handle.close(); }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function logWarnings(log: string): string[] {
    return [...new Set(log.split(/\r?\n/).filter(line =>
        /Missing character:|Overfull \\[hv]box|(?:LaTeX|Package .*?) Warning:/i.test(line)))];
}

async function failureWarnings(cwd: string): Promise<string[]> {
    try { return logWarnings((await readBoundedFile(path.join(cwd, 'book.log'), maximumLogBytes)).toString('utf8')); }
    catch { return []; }
}
function texWarnings(log: string): { source: string; message: string }[] {
    const records: { source: string; message: string }[] = [];
    let current: { source: string; message: string } | undefined;
    for (const line of log.split(/\r?\n/)) {
        const header = /^(LaTeX(?: Font)?|Package [\w.-]+|Class [\w.-]+) Warning(?: \([^)]*\))?:\s*(.*)$/.exec(line);
        if (header) {
            current = { source: header[1], message: header[2] };
            records.push(current);
        } else if (!line.trim() || /^(?:Overfull|Underfull|Missing character:|Latexmk:|!|\[|Output written|Transcript written)/.test(line)) {
            current = undefined;
        } else if (current) {
            current.message += ' ' + line.replace(/^\([\w.-]+\)\s*/, '').trim();
        }
    }
    return records.map(record => ({ ...record, message: record.message.replace(/\s+/g, ' ').trim() }));
}
function checkConvergence(log: string, transcript: string): void {
    const unresolved = /^(?:There (?:were|are) undefined (?:references|citations)\b|(?:Reference|Citation)\s+.*\bundefined\b|Label\(s\) may have changed\b|Rerun to get\b|Please (?:\(re\))?run (?:LaTeX|Biber|BibTeX)\b)/i;
    const pending = texWarnings(log).some(record => unresolved.test(record.message) ||
        (record.source === 'Package rerunfilecheck' && /^File\s+.*\bhas changed\b/i.test(record.message)));
    const exhausted = /^Latexmk:[ \t]*(?:Maximum (?:number of )?(?:runs|repeats)\b[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)?|Failure in processing file[^\r\n]*\r?\n[ \t]+[^\r\n]*\bneeded too many passes\b)/im;
    if (pending || exhausted.test(transcript)) {
        throw new Error('PDF references did not converge; inspect book.log and fix unresolved references or rerun requirements');
    }
}
async function buildPdf(runner: PdfProcessRunner, cwd: string,
    env: NodeJS.ProcessEnv, check: () => void): Promise<PdfCompilation> {
    const result = await runner(requestFor('latexmk', [
        '-norc', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
        '-file-line-error', '-no-shell-escape', '-e', '$max_repeat = 5;', 'book.tex'
    ], cwd, env, buildTimeoutMs));
    if (result.code !== 0) { throw new Error(`latexmk failed (exit ${result.code}).\n${result.output}`); }
    const log = (await readBoundedFile(path.join(cwd, 'book.log'), maximumLogBytes, check)).toString('utf8');
    checkConvergence(log, result.output);
    const pdf = await readBoundedFile(path.join(cwd, 'book.pdf'), maximumPdfBytes, check);
    check();
    if (pdf.length < 8 || !/^%PDF-[12]\.[0-9]/.test(pdf.subarray(0, 8).toString('ascii'))) {
        throw new Error('LuaLaTeX did not produce a valid PDF header in book.pdf');
    }
    return { pdf, warnings: logWarnings(log) };
}
async function compileStaged(directory: string, cwd: string, files: Parameters<PdfCompiler>[0],
    runner: PdfProcessRunner, check: () => void): Promise<PdfCompilation> {
    await stageFiles(directory, files, check);
    check();
    const env = await buildEnvironment(directory);
    check();
    const guarded = checkedRunner(runner, check);
    await preflight(guarded, cwd, env);
    check();
    return buildPdf(guarded, cwd, env, check);
}
async function compileInStage(files: Parameters<PdfCompiler>[0], entry: string, options: PdfCompileOptions,
    runner: PdfProcessRunner, check: () => void): Promise<PdfCompilation> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-pdf-'));
    const cwd = path.join(directory, path.posix.dirname(entry));
    let warnings: string[] = [];
    try {
        let result: PdfCompilation;
        try {
            result = await compileStaged(directory, cwd, files, runner, check);
            warnings = result.warnings;
        } catch (error) {
            warnings = await failureWarnings(cwd);
            throw error;
        } finally {
            if (!options.keepBuild) { await fs.rm(directory, { recursive: true, force: true }); }
        }
        check();
        return options.keepBuild ? { ...result, buildDirectory: directory } : result;
    } catch (error) {
        try { check(); } catch (cancellation) { error = cancellation; }
        throw new PdfCompilationError(errorMessage(error), options.keepBuild ? directory : undefined, warnings);
    }
}
export function createPdfCompiler(runner: PdfProcessRunner = runPdfProcess): PdfCompiler {
    return async (files, entry, options = {}) => {
        const lifetime = compilerLifetime();
        const check = (): void => { lifetime.check(); options.checkCancelled?.(); };
        try {
            check();
            const prepared = prepareFiles(files, entry);
            return await compileInStage(prepared, entry, options, runner, check);
        } catch (error) {
            if (error instanceof PdfCompilationError) { throw error; }
            throw new PdfCompilationError(errorMessage(error));
        } finally { lifetime.dispose(); }
    };
}
export const compilePdf: PdfCompiler = createPdfCompiler();
