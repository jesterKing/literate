/* Mocks preserve VS Code's public API names; fixture keys are filesystem paths. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import * as path from 'node:path';
import type * as vscode from 'vscode';

class Uri {
    readonly path: string;
    private readonly value: URL;
    constructor(value: string) {
        this.value = new URL(value);
        this.path = decodeURIComponent(this.value.pathname);
    }
    get fsPath(): string { return this.path; }
    toString(): string { return this.value.toString(); }
    static file(value: string): Uri { return new Uri('file:///' + value.replace(/^\//, '')); }
    static parse(value: string): Uri { return new Uri(value); }
    static joinPath(uri: Uri, ...parts: string[]): Uri {
        const value = new URL(uri.toString());
        value.pathname = path.posix.join(uri.path, ...parts);
        return new Uri(value.toString());
    }
}

class FileSystemError extends Error {
    constructor(readonly code: string) { super(code); }
}

export class Position {
    constructor(readonly line: number, readonly character: number) {}
    compareTo(other: Position): number { return this.line - other.line || this.character - other.character; }
    isEqual(other: Position): boolean { return this.compareTo(other) === 0; }
    translate(lineDelta = 0, characterDelta = 0): Position {
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: Position, end: Position);
    constructor(line: number, column: number, endLine: number, endColumn: number);
    constructor(start: Position | number, end: Position | number, endLine?: number, endColumn?: number) {
        this.start = typeof start === 'number' ? new Position(start, end as number) : start;
        this.end = typeof end === 'number' ? new Position(endLine!, endColumn!) : end;
    }
    contains(value: Position | Range): boolean {
        const start = value instanceof Range ? value.start : value;
        const end = value instanceof Range ? value.end : value;
        return this.start.compareTo(start) <= 0 && this.end.compareTo(end) >= 0;
    }
}

class WorkspaceEdit {
    private readonly edits = new Map<string, [Uri, { range: Range; newText: string }[]]>();
    replace(uri: Uri, range: Range, newText: string): void {
        if (!this.edits.has(uri.toString())) { this.edits.set(uri.toString(), [uri, []]); }
        this.edits.get(uri.toString())![1].push({ range, newText });
    }
    get(uri: Uri) { return this.edits.get(uri.toString())?.[1] || []; }
    entries() { return [...this.edits.values()]; }
    get size(): number { return this.edits.size; }
}

class Location {
    readonly range: Range;
    constructor(readonly uri: Uri, range: Range | Position) {
        this.range = range instanceof Range ? range : new Range(range, range);
    }
}
class MarkdownString { constructor(public value = '', readonly supportThemeIcons = false) {} }
class Hover {
    readonly contents: MarkdownString[];
    constructor(contents: MarkdownString | MarkdownString[], readonly range?: Range) {
        this.contents = Array.isArray(contents) ? contents : [contents];
    }
}
class EventEmitter<T> {
    private listeners = new Set<(event: T) => unknown>();
    readonly event = (listener: (event: T) => unknown) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void { for (const listener of this.listeners) { listener(event); } }
    dispose(): void { this.listeners.clear(); }
}
class RelativePattern {
    constructor(readonly base: { uri: Uri }, readonly pattern: string) {}
}

class Diagnostic {
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const disposable = () => ({ dispose() {} });
export const fence = (header: string, content = '') => '```' + header + '\n' + content
    + (content && !content.endsWith('\n') ? '\n' : '') + '```\n';
export const root = (content: string, settings = '') =>
    fence('text: <<main.*>>= generated/main.txt $ ' + settings, content);

export function fixture(workspaceUri = 'file:///project') {
    const folder = { name: 'project', uri: Uri.parse(workspaceUri), index: 0 };
    const other = { name: 'other', uri: Uri.file('/other'), index: 1 };
    const disk = new Map<string, Buffer>();
    const types = new Map<string, number>();
    const statErrors = new Map<string, string>();
    const stats: string[] = [], listings: string[] = [];
    const fileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
    const entryType = (key: string): number | undefined => {
        if (types.has(key)) { return types.get(key); }
        if (disk.has(key)) { return fileType.File; }
        if ([folder, other].some(base => base.uri.toString() === key)
            || [...disk.keys(), ...types.keys()].some(child => child.startsWith(key + '/'))) {
            return fileType.Directory;
        }
        return undefined;
    };
    const diagnostics = new Map<string, Diagnostic[]>();
    const reads: string[] = [], writes: string[] = [], directories: string[] = [], errors: string[] = [];
    let discoveries = 0;
    const changeListeners = new Set<(event: vscode.TextDocumentChangeEvent) => unknown>();
    const controls: { beforeWrite?: () => Promise<void>; readError?: string } = {};
    const versions = new Map<string, number>();
    const document = (name: string, text: string, base = folder): vscode.TextDocument => {
        const uri = Uri.joinPath(base.uri, name);
        const version = (versions.get(uri.toString()) || 0) + 1;
        versions.set(uri.toString(), version);
        const lines = text.split(/\r?\n/);
        const starts = [0];
        for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i + 1); } }
        const offsetAt = (position: Position) => Math.min(text.length, starts[position.line] + position.character);
        const positionAt = (offset: number) => {
            offset = Math.max(0, Math.min(text.length, offset));
            let line = starts.length - 1;
            while (starts[line] > offset) { line--; }
            return new Position(line, Math.min(lines[line].length, offset - starts[line]));
        };
        return {
            uri, version, languageId: 'markdown', fileName: uri.fsPath, isDirty: true, isClosed: false,
            eol: text.includes('\r\n') ? 2 : 1, lineCount: lines.length, offsetAt, positionAt,
            getText: (range?: Range) => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
            lineAt: (value: number | Position) => {
                const lineNumber = typeof value === 'number' ? value : value.line;
                const line = lines[lineNumber];
                return { lineNumber, text: line, range: new Range(lineNumber, 0, lineNumber, line.length),
                    firstNonWhitespaceCharacterIndex: line.search(/\S|$/), isEmptyOrWhitespace: !line.trim() };
            }
        } as unknown as vscode.TextDocument;
    };
    const collection = {
        forEach(callback: (uri: Uri, values: Diagnostic[]) => void) {
            for (const [key, values] of diagnostics) { callback(Uri.parse(key), values); }
        },
        set(uri: Uri, values: Diagnostic[]) { diagnostics.set(uri.toString(), values); },
        delete(uri: Uri) { diagnostics.delete(uri.toString()); },
        dispose() {}
    };
    const workspace = {
        workspaceFolders: [folder],
        textDocuments: [] as vscode.TextDocument[],
        getWorkspaceFolder(uri: Uri) {
            return [folder, other].find(base => uri.toString().startsWith(base.uri.toString() + '/'));
        },
        onDidChangeTextDocument(callback: (event: vscode.TextDocumentChangeEvent) => unknown) {
            changeListeners.add(callback);
            return { dispose: () => changeListeners.delete(callback) };
        },
        onDidChangeWorkspaceFolders() { return disposable(); },
        async findFiles(pattern: RelativePattern, exclude: unknown) {
            assert.equal(exclude, null, 'discovery must not apply editor search exclusions');
            discoveries++;
            await tick();
            return [...disk.keys()].filter(key => key.startsWith(pattern.base.uri.toString() + '/')
                && key.endsWith('.literate')).reverse().map(Uri.parse);
        },
        fs: {
            async stat(uri: Uri) {
                const key = uri.toString();
                stats.push(key);
                await tick();
                const error = statErrors.get(key);
                if (error) { throw new FileSystemError(error); }
                const type = entryType(key);
                if (type === undefined) { throw new FileSystemError('FileNotFound'); }
                return { type, ctime: 0, mtime: 0, size: disk.get(key)?.length || 0 };
            },
            async readDirectory(uri: Uri): Promise<[string, number][]> {
                const key = uri.toString();
                listings.push(key);
                await tick();
                const type = entryType(key);
                if (type === undefined) { throw new FileSystemError('FileNotFound'); }
                if (type !== fileType.Directory) { throw new FileSystemError('FileNotADirectory'); }
                const names = new Set<string>();
                for (const child of [...disk.keys(), ...types.keys()]) {
                    if (child.startsWith(key + '/')) {
                        names.add(decodeURIComponent(child.slice(key.length + 1).split('/')[0]));
                    }
                }
                return [...names].map(name => [name, entryType(Uri.joinPath(uri, name).toString())!]);
            },
            async readFile(uri: Uri) {
                reads.push(uri.toString());
                await tick();
                if (controls.readError) { throw new FileSystemError(controls.readError); }
                const content = disk.get(uri.toString());
                if (content === undefined) { throw new FileSystemError('FileNotFound'); }
                return Buffer.from(content);
            },
            async createDirectory(uri: Uri) {
                await tick();
                directories.push(uri.toString());
                types.set(uri.toString(), fileType.Directory);
            },
            async writeFile(uri: Uri, content: Uint8Array) {
                assert.ok(directories.includes(Uri.joinPath(uri, '..').toString()),
                    'parent directory creation must finish before writing');
                if (controls.beforeWrite) { await controls.beforeWrite(); }
                await tick();
                disk.set(uri.toString(), Buffer.from(content));
                writes.push(uri.toString());
                // Model an open generated document changing; it must not enqueue generation.
                await change(document(path.posix.relative(folder.uri.path, uri.path), Buffer.from(content).toString()));
            }
        }
    };
    const providers = new Map<string, unknown>();
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const executedCommands: string[] = [];
    const register = (kind: string) => (_selector: unknown, provider: unknown) => {
        providers.set(kind, provider); return disposable();
    };
    const mock = {
        Uri, FileSystemError, FileType: fileType, Position, Range, WorkspaceEdit, Location, Hover, MarkdownString, EventEmitter,
        Diagnostic, DiagnosticSeverity: { Error: 0 }, RelativePattern, workspace,
        TreeItem: class { constructor(readonly label: string, readonly collapsibleState: number) {} },
        ThemeIcon: class { constructor(readonly id: string) {} },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        languages: {
            createDiagnosticCollection: () => collection,
            registerCompletionItemProvider: register('completion'), registerDefinitionProvider: register('definition'),
            registerReferenceProvider: register('references'), registerHoverProvider: register('hover'),
            registerRenameProvider: register('rename'), registerCodeActionsProvider: register('codeActions')
        },
        commands: {
            registerCommand(name: string, callback: (...args: unknown[]) => unknown) {
                commands.set(name, callback); return disposable();
            },
            async executeCommand(name: string, ...args: unknown[]) {
                executedCommands.push(name);
                return commands.get(name)?.(...args);
            }
        },
        window: {
            showErrorMessage: (message: string) => { errors.push(message); },
            showInformationMessage: () => undefined, setStatusBarMessage: disposable,
            registerTreeDataProvider: register('tree'), createTreeView: disposable
        }
    };

    // node --test isolates test files in separate processes. The private CommonJS hook
    // is scoped to this synchronous require; each fixture gets its own captured mock.
    const loader = require('node:module') as {
        _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
    };
    const originalLoad = loader._load;
    const extensionPath = require.resolve('../../extension'); // out/extension.js after compilation
    const previousModule = require.cache[extensionPath];
    let extension: typeof import('../../extension');
    try {
        delete require.cache[extensionPath];
        loader._load = function (request, parent, isMain) {
            return request === 'vscode' ? mock : originalLoad.call(this, request, parent, isMain);
        };
        extension = require(extensionPath) as typeof import('../../extension');
    } finally {
        loader._load = originalLoad;
        if (previousModule) { require.cache[extensionPath] = previousModule; }
        else { delete require.cache[extensionPath]; }
    }
    const repository = new extension.FragmentRepository({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const uri = (name: string, base = folder) => Uri.joinPath(base.uri, name).toString();
    const put = (name: string, content: string, base = folder) => { disk.set(uri(name, base), Buffer.from(content)); };
    const open = (name: string, text: string, base = folder) => {
        const doc = document(name, text, base);
        workspace.textDocuments = workspace.textDocuments.filter(old => old.uri.toString() !== doc.uri.toString());
        workspace.textDocuments.push(doc);
        return doc;
    };
    async function change(doc: vscode.TextDocument, text = 'changed', contentChanges = true): Promise<void> {
        for (const listener of changeListeners) {
            await listener({ document: doc, contentChanges: contentChanges ? [{ text }] : []
            } as unknown as vscode.TextDocumentChangeEvent);
        }
    }
    const process = (writeFiles?: boolean) => repository.processLiterateFiles(
        folder as unknown as vscode.WorkspaceFolder, writeFiles);
    return { folder, other, disk, types, statErrors, stats, listings, diagnostics, reads, writes, directories, errors, controls,
        workspace, repository, extension, mock, providers, commands, executedCommands, document, open, uri, put, change, process,
        get docs() { return workspace.textDocuments; }, discoveries: () => discoveries };
}
