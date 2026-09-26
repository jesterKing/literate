import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { renderLatex, LatexConverter, LatexOptions } from './publication-latex';
import { planFonts } from './publication-fonts';
import { resolvePublicationSettings } from './publication-settings';
import { commitOutputs, OutputTransactionError, TransactionIO } from './output-transactions';
import { discoveryExcludedDirectories, generateProject, parseProject, resolveProjectTheme, safeRelativePath, templateReferences, SourceDocument } from './engine';

export interface CliIO {
    stdout(message: string): void;
    stderr(message: string): void;
}

type Generation = ReturnType<typeof generateProject>;
type OutputStatus = 'current' | 'missing' | 'stale' | 'written';
interface CliResponse {
    schemaVersion: 1;
    command: string;
    ok: boolean;
    root?: string;
    diagnostics: Generation['diagnostics'];
    errors: string[];
    outputs: { path: string; status: OutputStatus }[];
    inspection?: Generation['inspection'];
    selfHosting?: { ok: boolean; checks: { name: string; ok: boolean; message?: string }[] };
    usage?: string;
}

const commands = ['generate', 'check', 'inspect', 'self-check', 'latex'];
const latexMarginOptions = [
    ['--margin', 'marginMm'], ['--margin-top', 'marginTopMm'], ['--margin-right', 'marginRightMm'],
    ['--margin-bottom', 'marginBottomMm'], ['--margin-left', 'marginLeftMm']
] as const;
const latexValueFlags = ['--output', '--paper', '--font-manifest', ...latexMarginOptions.map(([flag]) => flag)];
const latexUsage = 'latex [root] --output path.tex [--paper a4|a5|letter|legal] [--margin 20mm]'
    + ' [--margin-top Nmm] [--margin-right Nmm] [--margin-bottom Nmm] [--margin-left Nmm] [--font-manifest path.json] [--json]';
const usage = 'Usage: node out/cli.js generate|check|inspect|self-check [root] [--json]\n'
    + `       node out/cli.js ${latexUsage}\n`
    + '       node out/cli.js <command> --help [--json]\n       node out/cli.js --help [--json]\n';
const descriptions: Record<string, string> = Object.fromEntries([
    ['generate', 'Write missing or changed generated files.'],
    ['latex', 'Export a .tex book using Pandoc on PATH; output is relative to root, not the working directory. Defaults: a4, 20mm. Margins: numeric mm, 5–50, leaving at least an 80 × 100 mm body. Each side overrides --margin; unspecified sides use --margin or 20mm. Fonts resolve from root index.literate SETTINGS. No TeX/PDF execution. --font-manifest opts into explicit font/license companions.'],
    ['check', 'Report missing or stale generated files without writing.'],
    ['inspect', 'Report documents, templates, and fragment definitions and dependencies without reading outputs or writing.'],
    ['self-check', 'Verify this repository’s trusted self-hosting code without generating files; all outputs must already be current.']
]);

const excluded = new Set(discoveryExcludedDirectories);
const defaultIO: CliIO = {
    stdout: message => { process.stdout.write(message); },
    stderr: message => { process.stderr.write(message); }
};

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function relative(value: string): string {
    const normalized = safeRelativePath(value);
    if (!normalized) { throw new Error(`Invalid relative path: ${value}`); }
    return normalized;
}

async function inspect(root: string, value: string): Promise<boolean> {
    const parts = relative(value).split('/');
    let current = root;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (missing(error)) { return false; }
            throw error;
        }
        if (stat.isSymbolicLink()) { throw new Error(`Symbolic link is not allowed: ${value}`); }
        if (index < parts.length - 1) {
            if (!stat.isDirectory()) { throw new Error(`Parent is not a directory: ${value}`); }
        } else if (!stat.isFile()) {
            throw new Error(`Target is not a regular file: ${value}`);
        }
    }
    return true;
}

export function createTransactionIO(root: string): TransactionIO {
    root = path.resolve(root);
    const modes = new Map<string, number>();
    const target = (value: string): string => path.join(root, relative(value));
    const inspectPath: TransactionIO['inspect'] = async value => {
        const parts = relative(value).split('/');
        const rootStat = await fs.lstat(root);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error(`Root is not a regular directory: ${root}`);
        }
        let current = root;
        for (const [index, part] of parts.entries()) {
            current = path.join(current, part);
            let stat;
            try { stat = await fs.lstat(current); }
            catch (error) {
                if (missing(error)) { return 'missing'; }
                throw error;
            }
            if (stat.isSymbolicLink()) { throw new Error(`Symbolic link is not allowed: ${value}`); }
            if (index < parts.length - 1) {
                if (!stat.isDirectory()) { throw new Error(`Parent is not a directory: ${value}`); }
            } else {
                if (stat.isFile()) { return 'file'; }
                if (stat.isDirectory()) { return 'directory'; }
                throw new Error(`Target is not a regular file or directory: ${value}`);
            }
        }
        throw new Error(`Invalid relative path: ${value}`);
    };
    return {
        inspect: inspectPath,
        async read(value) {
            if (await inspectPath(value) !== 'file') { throw new Error(`Not a file: ${value}`); }
            const stat = await fs.lstat(target(value));
            const bytes = await fs.readFile(target(value));
            modes.set(relative(value), stat.mode & 0o7777);
            return bytes;
        },
        async mkdir(value) {
            if (await inspectPath(value) !== 'missing') { throw new Error(`Path exists: ${value}`); }
            await fs.mkdir(target(value));
        },
        async writeNew(value, content) {
            if (await inspectPath(value) !== 'missing') { throw new Error(`Path exists: ${value}`); }
            await fs.writeFile(target(value), content, { flag: 'wx' });
        },
        async rename(from, to) {
            if (await inspectPath(from) !== 'file') { throw new Error(`Not a file: ${from}`); }
            if (await inspectPath(to) !== 'missing') { throw new Error(`Path exists: ${to}`); }
            const mode = modes.get(relative(to));
            if (from.endsWith('.stage') && mode !== undefined) { await fs.chmod(target(from), mode); }
            await fs.rename(target(from), target(to));
        },
        async removeFile(value) {
            if (await inspectPath(value) !== 'file') { throw new Error(`Not a file: ${value}`); }
            await fs.unlink(target(value));
        },
        async removeDirectory(value) {
            if (await inspectPath(value) !== 'directory') { throw new Error(`Not a directory: ${value}`); }
            await fs.rmdir(target(value));
        },
        nonce: randomUUID
    };
}

async function discover(root: string): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    const visit = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            if (entry.isSymbolicLink()) { continue; }
            const name = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!excluded.has(entry.name)) { await visit(name); }
            } else if (entry.isFile() && entry.name.endsWith('.literate')) {
                const normalized = relative(name);
                if (!await inspect(root, normalized)) { throw new Error(`Source disappeared: ${name}`); }
                documents.push({ path: normalized, text: await fs.readFile(path.join(root, normalized), 'utf8') });
            }
        }
    };
    await visit('');
    return documents;
}

export const runPandoc: LatexConverter = async document => {
    const input = JSON.stringify(document);
    return new Promise<string>((resolve, reject) => {
        const child = spawn('pandoc', [
            '--from=json', '--to=latex', '--top-level-division=chapter', '--no-highlight'
        ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outputBytes = 0, errorBytes = 0;
        let settled = false;
        let inputError: Error | undefined;
        const detail = (): string => Buffer.concat(stderr).toString('utf8').slice(0, 2048)
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
        const complete = (error?: Error): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (error) {
                child.kill('SIGKILL');
                child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
                const diagnostic = detail();
                reject(new Error(error.message + (diagnostic ? `: ${diagnostic}` : '')));
            } else { resolve(Buffer.concat(stdout).toString('utf8')); }
        };
        const timer = setTimeout(() => complete(new Error('Pandoc timed out after 30000 ms')), 30000);
        child.stdout.on('data', (chunk: Buffer) => {
            if (settled) { return; }
            outputBytes += chunk.length;
            if (outputBytes > 16 * 1024 * 1024) { complete(new Error('Pandoc stdout exceeded 16 MiB')); }
            else { stdout.push(chunk); }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (settled) { return; }
            errorBytes += chunk.length;
            const remaining = 64 * 1024 - (errorBytes - chunk.length);
            if (remaining > 0) { stderr.push(chunk.subarray(0, remaining)); }
            if (errorBytes > 64 * 1024) { complete(new Error('Pandoc stderr exceeded 64 KiB')); }
        });
        child.stdin.on('error', error => { inputError = error; });
        child.stdout.on('error', error => complete(error));
        child.stderr.on('error', error => complete(error));
        child.on('error', error => complete(new Error(missing(error)
            ? 'Pandoc was not found; install Pandoc and ensure pandoc is on PATH, then retry latex'
            : `Unable to run Pandoc: ${error.message}`)));
        child.on('close', (code, signal) => {
            if (code !== 0) { complete(new Error(`Pandoc failed (${signal ? 'signal ' + signal : 'exit ' + code})`)); }
            else if (inputError) { complete(new Error(`Pandoc stdin failed: ${inputError.message}`)); }
            else if (!outputBytes) { complete(new Error('Pandoc returned an empty LaTeX body')); }
            else { complete(); }
        });
        child.stdin.end(input);
    });
};
async function planLatex(root: string, documents: SourceDocument[], output: string,
    options: LatexOptions, convert: LatexConverter, manifest?: string): Promise<{
        files: { path: string; content: string | Uint8Array }[]; diagnostics: Generation['diagnostics'];
        inspection?: Generation['inspection'];
    }> {
    const theme = resolveProjectTheme(documents);
    if (theme.diagnostics.length) { return { files: [], diagnostics: theme.diagnostics }; }
    const project = parseProject(documents);
    const settings = resolvePublicationSettings(project);
    if (settings.diagnostics.length) { return { files: [], diagnostics: settings.diagnostics }; }
    const companions = manifest ? await planFonts(manifest, output, Object.values(settings.fonts), {
        async requireFile(value) {
            if (!await inspect(root, value)) { throw new Error(`Missing file: ${value}`); }
        },
        async read(value) {
            if (!await inspect(root, value)) { throw new Error(`Input disappeared: ${value}`); }
            return fs.readFile(path.join(root, value));
        }
    }) : undefined;
    const inputs = [...documents.map(document => document.path), ...templateReferences(documents),
        ...(companions?.inputs ?? [])];
    for (const destination of [output, ...(companions?.files.map(file => file.path) ?? [])]) {
        const target = destination.toLowerCase();
        for (const input of inputs) {
            const source = relative(input).toLowerCase();
            if (target === source || target.startsWith(source + '/') || source.startsWith(target + '/')) {
                throw new Error(`LaTeX output conflicts with input: ${input} (output ${destination})`);
            }
        }
        await inspect(root, destination);
    }
    const rendered = await renderLatex(project, { ...options, theme: theme.name,
        portableFonts: companions?.fonts }, convert);
    if (!rendered.diagnostics.length && rendered.latex === undefined) {
        throw new Error('LaTeX renderer returned no document');
    }
    return { diagnostics: rendered.diagnostics, files: rendered.diagnostics.length ? []
        : [{ path: output, content: rendered.latex! }, ...(companions?.files ?? [])] };
}
export async function run(args: string[], io: CliIO = defaultIO,
    transactionIO: (root: string) => TransactionIO = createTransactionIO,
    convert: LatexConverter = runPandoc): Promise<number> {
    const json = args.includes('--json');
    const positional: string[] = [];
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const latexOptions: LatexOptions = {};
    let latexOutput = '';
    const response: CliResponse = {
        schemaVersion: 1, command: 'help', ok: false, diagnostics: [], errors: [], outputs: []
    };
    const finish = (code: number): number => {
        response.ok = code === 0;
        if (json) { io.stdout(JSON.stringify(response) + '\n'); }
        return code;
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (latexValueFlags.includes(arg)) {
            if (flags.has(arg)) { response.errors.push(`Duplicate flag: ${arg}`); }
            flags.add(arg);
            const value = args[index + 1];
            if (!value || value.startsWith('-')) { response.errors.push(`Missing value for ${arg}`); }
            else { values.set(arg, value); index++; }
        } else if (arg.startsWith('-')) {
            const flag = arg === '-h' ? '--help' : arg;
            if (!['--help', '--json'].includes(flag)) { response.errors.push(`Unknown flag: ${arg}`); }
            else if (flags.has(flag)) { response.errors.push(`Duplicate flag: ${arg}`); }
            flags.add(flag);
        } else { positional.push(arg); }
    }
    const command = positional[0];
    response.command = command || 'help';
    const helpCommand = command === 'help';
    const help = helpCommand || flags.has('--help');
    const topic = helpCommand ? positional[1] : command;
    if (command && !helpCommand && !commands.includes(command)) {
        response.errors.push(`Unknown command: ${command}`);
    }
    if ((!command && !help) || positional.some(arg => !arg) || positional.length > 2 ||
        (helpCommand && flags.has('--help')) || (helpCommand && topic && !commands.includes(topic))) {
        response.errors.push('Invalid arguments');
    }
    if (topic !== 'latex' && latexValueFlags.some(flag => flags.has(flag))) {
        response.errors.push(`${latexValueFlags.join(', ')} are only valid for latex`);
    }
    if (topic === 'latex') {
        const manifest = values.get('--font-manifest');
        if (manifest !== undefined && !safeRelativePath(manifest)) {
            response.errors.push('--font-manifest requires a safe root-relative JSON file path');
        }
        const output = values.get('--output');
        latexOutput = output ? safeRelativePath(output) || '' : '';
        if ((!help || output !== undefined) && (!latexOutput || !latexOutput.endsWith('.tex'))) {
            response.errors.push('latex requires --output with a safe root-relative .tex path');
        }
        const paper = values.get('--paper') ?? 'a4';
        if (!['a4', 'a5', 'letter', 'legal'].includes(paper)) {
            response.errors.push('--paper must be a4, a5, letter or legal');
        }
        latexOptions.paper = (paper === 'a4' ? 'A4' : paper === 'a5' ? 'A5' : paper) as LatexOptions['paper'];
        for (const [flag, option] of latexMarginOptions) {
            const margin = values.get(flag) ?? (flag === '--margin' ? '20mm' : undefined);
            if (margin === undefined) { continue; }
            const mm = Number(margin.slice(0, -2));
            if (!/^\d+(?:\.\d+)?mm$/.test(margin) || !Number.isFinite(mm) || mm < 5 || mm > 50) {
                response.errors.push(`${flag} requires numeric mm, 5–50`);
            }
            latexOptions[option] = mm;
        }
        const paperSizes: Record<string, [number, number]> = {
            a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4], legal: [215.9, 355.6]
        };
        if (!response.errors.length) {
            const [width, height] = paperSizes[paper];
            const uniform = latexOptions.marginMm ?? 20;
            const horizontal = (latexOptions.marginLeftMm ?? uniform) + (latexOptions.marginRightMm ?? uniform);
            const vertical = (latexOptions.marginTopMm ?? uniform) + (latexOptions.marginBottomMm ?? uniform);
            if (width - horizontal < 80 || height - vertical < 100) {
                response.errors.push('Margins must leave at least an 80 × 100 mm body for the selected paper');
            }
        }
    }
    if (response.errors.length) {
        if (!json) { io.stderr(response.errors.join('\n') + '\n' + usage); }
        return finish(2);
    }
    if (help) {
        response.command = 'help';
        response.usage = topic
            ? `Usage: node out/cli.js ${topic === 'latex' ? latexUsage : topic + ' [root] [--json]'}\n${descriptions[topic]}\n`
            : usage;
        if (!json) { io.stdout(response.usage); }
        return finish(0);
    }
    try {
        const root = await fs.realpath(path.resolve(positional[1] || process.cwd()));
        response.root = root;
        if (!(await fs.stat(root)).isDirectory()) { throw new Error('Root is not a directory'); }
        const documents = await discover(root);
        if (!documents.length) { throw new Error('No literate documents found'); }
        const templates: Record<string, string> = Object.create(null);
        for (const reference of templateReferences(documents)) {
            if (await inspect(root, reference)) {
                templates[reference] = await fs.readFile(path.join(root, reference), 'utf8');
            }
        }
        const result = command === 'latex'
            ? await planLatex(root, documents, latexOutput, latexOptions, convert,
                values.has('--font-manifest') ? relative(values.get('--font-manifest')!) : undefined)
            : generateProject(documents, templates);
        response.diagnostics = result.diagnostics;
        if (command === 'inspect') {
            response.inspection = result.inspection;
            if (!json) { io.stdout(JSON.stringify(result.inspection, null, 2) + '\n'); }
        }
        if (result.diagnostics.length) {
            if (!json) {
                for (const diagnostic of result.diagnostics) {
                    io.stderr(`${diagnostic.path}:${diagnostic.line + 1}:${diagnostic.column + 1}: ${diagnostic.message}\n`);
                }
            }
            return finish(1);
        }
        if (command === 'inspect') { return finish(0); }
        const files = result.files.map(file => ({ path: relative(file.path), content: file.content }));
        const targets = new Set<string>();
        for (const file of files) {
            if (targets.has(file.path)) { throw new Error(`Duplicate output: ${file.path}`); }
            targets.add(file.path);
        }
        for (const target of targets) {
            const parts = target.split('/');
            for (let index = 1; index < parts.length; index++) {
                const parent = parts.slice(0, index).join('/');
                if (targets.has(parent)) { throw new Error(`Output is also a parent directory: ${parent}`); }
            }
        }
        const changes: { path: string; content: string | Uint8Array; output: CliResponse['outputs'][number] }[] = [];
        for (const file of files) {
            const exists = await inspect(root, file.path);
            const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
            const status: OutputStatus = !exists ? 'missing'
                : (await fs.readFile(path.join(root, file.path))).equals(content) ? 'current' : 'stale';
            const output = { path: file.path, status };
            response.outputs.push(output);
            if (status !== 'current') { changes.push({ ...file, output }); }
        }
        if (command === 'check' || command === 'self-check') {
            if (!json) {
                for (const change of changes) { io.stdout(`${change.output.status}: ${change.path}\n`); }
            }
            if (changes.length) { return finish(1); }
            if (command === 'self-check') {
                const { verifySelfHosting } = await import('./self-hosting');
                response.selfHosting = await verifySelfHosting(root, documents, templates, files.map(file => {
                    if (typeof file.content !== 'string') { throw new Error('Self-hosting requires text outputs'); }
                    return { path: file.path, content: file.content };
                }));
                if (!json) {
                    for (const check of response.selfHosting.checks) {
                        io.stdout(`${check.ok ? 'ok' : 'failed'}: ${check.name}${check.message ? ': ' + check.message : ''}\n`);
                    }
                }
                return finish(response.selfHosting.ok ? 0 : 1);
            }
            return finish(0);
        }
        const markWritten = (paths: readonly string[]): void => {
            const written = new Set(paths);
            for (const output of response.outputs) {
                if (!written.has(output.path)) { continue; }
                output.status = 'written';
                if (!json) { io.stdout(`generated: ${output.path}\n`); }
            }
        };
        try {
            const written = await commitOutputs(files.map(file => ({
                path: file.path, content: typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content
            })), transactionIO(root));
            markWritten(written);
        } catch (error) {
            if (error instanceof OutputTransactionError && error.committed) {
                markWritten(error.changedPaths);
            }
            throw error;
        }
        return finish(0);
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
        response.errors.push(message);
        if (!json) { io.stderr(`literate: ${message}\n`); }
        return finish(1);
    }
}

if (require.main === module) {
    void run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
