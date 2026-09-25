import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { commitOutputs, OutputTransactionError, TransactionIO } from './output-transactions';
import { discoveryExcludedDirectories, generateProject, safeRelativePath, templateReferences, SourceDocument } from './engine';

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

const commands = ['generate', 'check', 'inspect', 'self-check'];
const usage = 'Usage: node out/cli.js generate|check|inspect|self-check [root] [--json]\n       node out/cli.js <command> --help [--json]\n       node out/cli.js --help [--json]\n';
const descriptions: Record<string, string> = Object.fromEntries([
    ['generate', 'Write missing or changed generated files.'],
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

export async function run(args: string[], io: CliIO = defaultIO,
    transactionIO: (root: string) => TransactionIO = createTransactionIO): Promise<number> {
    const json = args.includes('--json');
    const positional: string[] = [];
    const flags = new Set<string>();
    const response: CliResponse = {
        schemaVersion: 1, command: 'help', ok: false, diagnostics: [], errors: [], outputs: []
    };
    const finish = (code: number): number => {
        response.ok = code === 0;
        if (json) { io.stdout(JSON.stringify(response) + '\n'); }
        return code;
    };
    for (const arg of args) {
        if (arg.startsWith('-')) {
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
    if (response.errors.length) {
        if (!json) { io.stderr(response.errors.join('\n') + '\n' + usage); }
        return finish(2);
    }
    if (help) {
        response.command = 'help';
        response.usage = topic
            ? `Usage: node out/cli.js ${topic} [root] [--json]\n${descriptions[topic]}\n`
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
        const result = generateProject(documents, templates);
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
        const changes: { path: string; content: string; output: CliResponse['outputs'][number] }[] = [];
        for (const file of files) {
            const exists = await inspect(root, file.path);
            const content = Buffer.from(file.content, 'utf8');
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
                response.selfHosting = await verifySelfHosting(root, documents, templates, files);
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
                path: file.path, content: Buffer.from(file.content, 'utf8')
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
