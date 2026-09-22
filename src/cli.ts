import * as fs from 'fs/promises';
import * as path from 'path';
import { discoveryExcludedDirectories, generateProject, safeRelativePath, templateReferences, SourceDocument } from './engine';

export interface CliIO {
    stdout(message: string): void;
    stderr(message: string): void;
}

const usage = 'Usage: node out/cli.js generate|check [root]\n       node out/cli.js --help\n';
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

/** Reject links and non-directory ancestors, including links that stay inside root. */
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


export async function run(args: string[], io: CliIO = defaultIO): Promise<number> {
    if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
        io.stdout(usage);
        return 0;
    }
    if (args.length < 1 || args.length > 2 || !['generate', 'check'].includes(args[0]) ||
        (args.length === 2 && (!args[1] || args[1].startsWith('-')))) {
        io.stderr(usage);
        return 2;
    }
    try {

        const root = await fs.realpath(path.resolve(args[1] || process.cwd()));
        if (!(await fs.stat(root)).isDirectory()) { throw new Error('Root is not a directory'); }
        const documents = await discover(root);
        const templates: Record<string, string> = Object.create(null);
        for (const reference of templateReferences(documents)) {

            if (await inspect(root, reference)) {
                templates[reference] = await fs.readFile(path.join(root, reference), 'utf8');
            }
        }
        const result = generateProject(documents, templates);
        if (result.diagnostics.length) {
            for (const diagnostic of result.diagnostics) {
                io.stderr(`${diagnostic.path}:${diagnostic.line + 1}:${diagnostic.column + 1}: ${diagnostic.message}\n`);
            }
            return 1;
        }
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
        const changes: { path: string; content: string; status: string }[] = [];

        for (const file of files) {
            const exists = await inspect(root, file.path);
            const content = Buffer.from(file.content, 'utf8');
            if (!exists || !(await fs.readFile(path.join(root, file.path))).equals(content)) {
                changes.push({ ...file, status: exists ? 'stale' : 'missing' });
            }
        }
        if (args[0] === 'check') {
            for (const change of changes) { io.stdout(`${change.status}: ${change.path}\n`); }
            return changes.length ? 1 : 0;
        }
        for (const change of changes) {
            await inspect(root, change.path);
            const target = path.join(root, change.path);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await inspect(root, change.path);
            await fs.writeFile(target, change.content, 'utf8');
            io.stdout(`generated: ${change.path}\n`);
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`literate: ${message.replace(/[\r\n]+/g, ' ')}\n`);
        return 1;
    }
}

if (require.main === module) {
    void run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
