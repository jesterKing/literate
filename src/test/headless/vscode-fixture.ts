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
    get scheme(): string { return this.value.protocol.slice(0, -1); }
        get authority(): string { return this.value.host; }
        get fragment(): string { return this.value.hash.slice(1); }
    toString(): string { return this.value.toString(); }
    static file(value: string): Uri { return new Uri('file:///' + value.replace(/^\//, '')); }
    static parse(value: string): Uri { return new Uri(value); }
    static joinPath(uri: Uri, ...parts: string[]): Uri {
        const value = new URL(uri.toString());
        value.pathname = path.posix.join(uri.path, ...parts).split('/').map(encodeURIComponent).join('/');
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
    insert(uri: Uri, position: Position, newText: string): void {
        this.replace(uri, new Range(position, position), newText);
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

class CodeActionKind {
    static readonly QuickFix = new CodeActionKind('quickfix');
    static readonly Refactor = new CodeActionKind('refactor');
    constructor(readonly value: string) {}
    append(parts: string): CodeActionKind { return new CodeActionKind(this.value ? this.value + '.' + parts : parts); }
    intersects(other: CodeActionKind): boolean { return this.contains(other) || other.contains(this); }
    contains(other: CodeActionKind): boolean {
        return !this.value || other.value === this.value || other.value.startsWith(this.value + '.');
    }
}
class CodeAction {
    diagnostics?: vscode.Diagnostic[];
    edit?: vscode.WorkspaceEdit;
    command?: vscode.Command;
    constructor(readonly title: string, readonly kind?: CodeActionKind) {}
}
class Diagnostic {
    code?: vscode.Diagnostic['code'];
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
    const modes = new Map<string, number>();
    const modeStats: string[] = [], modeChanges: { uri: string; mode: number }[] = [];
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
    // writes tracks installed outputs; stagedWrites tracks provider writeFile calls.
    const reads: string[] = [], writes: string[] = [], stagedWrites: string[] = [], directories: string[] = [], errors: string[] = [];
    const renames: { from: string; to: string }[] = [];
    const deletions: string[] = [];
    let discoveries = 0;
    const changeListeners = new Set<(event: vscode.TextDocumentChangeEvent) => unknown>();
        const workspaceEvents = new EventEmitter<{ added: typeof folder[]; removed: typeof folder[] }>();
    const fileEvents = { create: new EventEmitter<Uri>(), change: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>() };
    const controls: {
        beforeWrite?: (uri: string) => Promise<void>;
        // beforeRename runs before mutation; afterRename runs after mutation and tracking.
        beforeRename?: (from: string, to: string) => void | Promise<void>;
        afterRename?: (from: string, to: string) => void | Promise<void>;
        afterCreateDirectory?: (uri: string) => void | Promise<void>;
        beforeDelete?: (uri: string) => void | Promise<void>;
        externalUri?: (uri: Uri) => Promise<Uri>;
                beforeOpen?: () => void | Promise<void>;
                readError?: string;
        chmodError?: string;
    } = {};
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
    const opened: { document: vscode.TextDocument; selection: Range }[] = [];
    const externalUris: Uri[] = [];
    let uriHandler: { handleUri(uri: Uri): Promise<void> } | undefined;
    const workspace = {
        isTrusted: true,
        workspaceFolders: [folder],
        async openTextDocument(uri: Uri) {
            await controls.beforeOpen?.();
            const existing = workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === uri.toString());
            if (existing) { return existing; }
            const content = disk.get(uri.toString());
            if (!content) { throw new FileSystemError('FileNotFound'); }
            return open(path.posix.relative(folder.uri.path, uri.path), content.toString());
        },
        textDocuments: [] as vscode.TextDocument[],
        getWorkspaceFolder(uri: Uri) {
            return [folder, other].find(base => uri.toString().startsWith(base.uri.toString() + '/'));
        },
        onDidChangeTextDocument(callback: (event: vscode.TextDocumentChangeEvent) => unknown) {
            changeListeners.add(callback);
            return { dispose: () => changeListeners.delete(callback) };
        },
        onDidChangeWorkspaceFolders: workspaceEvents.event,
        onDidChangeConfiguration: () => disposable(),
        onDidGrantWorkspaceTrust: () => disposable(),
        onDidOpenTextDocument: () => disposable(),
        onDidCloseTextDocument: () => disposable(),
        getConfiguration: () => ({ inspect: () => undefined }),
        createFileSystemWatcher(pattern: string) {
            assert.ok(pattern === '**/*' || pattern === '**/*.literate');
            return { onDidCreate: fileEvents.create.event, onDidChange: fileEvents.change.event,
                onDidDelete: fileEvents.delete.event,
                dispose() { for (const event of Object.values(fileEvents)) { event.dispose(); } } };
        },
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
                await controls.afterCreateDirectory?.(uri.toString());
            },
            async writeFile(uri: Uri, content: Uint8Array) {
                assert.ok(directories.includes(Uri.joinPath(uri, '..').toString()),
                    'parent directory creation must finish before writing');
                if (controls.beforeWrite) { await controls.beforeWrite(uri.toString()); }
                await tick();
                disk.set(uri.toString(), Buffer.from(content));
                if (!modes.has(uri.toString())) { modes.set(uri.toString(), 0o644); }
                stagedWrites.push(uri.toString());
                if (!/\/\.literate-txn-[^/]+\/\d+\.stage$/.test(uri.toString())) { writes.push(uri.toString()); }
                fileEvents.create.fire(uri);
                // Model an open generated document changing; it must not enqueue generation.
                await change(document(path.posix.relative(folder.uri.path, uri.path), Buffer.from(content).toString()));
            },
            async rename(from: Uri, to: Uri, options: { overwrite: boolean }) {
                assert.deepEqual(options, { overwrite: false });
                const source = from.toString(), target = to.toString();
                await controls.beforeRename?.(source, target);
                await tick();
                if (entryType(target) !== undefined) { throw new FileSystemError('FileExists'); }
                assert.equal(entryType(Uri.joinPath(to, '..').toString()), fileType.Directory);
                const content = disk.get(source);
                if (!content) { throw new FileSystemError('FileNotFound'); }
                disk.set(target, content);
                modes.set(target, modes.get(source) ?? 0o644);
                modes.delete(source);
                disk.delete(source);
                types.delete(source);
                renames.push({ from: source, to: target });
                if (/\/\.literate-txn-[^/]+\/\d+\.stage$/.test(source)) { writes.push(target); }
                fileEvents.delete.fire(from);
                fileEvents.create.fire(to);
                await change(document(path.posix.relative(folder.uri.path, to.path), content.toString()));
                await controls.afterRename?.(source, target);
            },
            async delete(uri: Uri, options: { recursive: boolean; useTrash: boolean }) {
                assert.deepEqual(options, { recursive: false, useTrash: false });
                await controls.beforeDelete?.(uri.toString());
                await tick();
                const key = uri.toString();
                const type = entryType(key);
                if (type === undefined) { throw new FileSystemError('FileNotFound'); }
                if (type === fileType.Directory && [...disk.keys(), ...types.keys()].some(child => child.startsWith(key + '/'))) {
                    throw new FileSystemError('DirectoryNotEmpty');
                }
                disk.delete(key);
                modes.delete(key);
                types.delete(key);
                deletions.push(key);
                fileEvents.delete.fire(uri);
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
        Diagnostic, DiagnosticSeverity: { Error: 0 }, CodeAction, CodeActionKind, EndOfLine: { LF: 1, CRLF: 2 }, RelativePattern, workspace,
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
        env: { uriScheme: 'vscode', async asExternalUri(uri: Uri) {
            externalUris.push(uri);
            return controls.externalUri ? controls.externalUri(uri) : Uri.parse(uri.toString() + '?windowId%3D1');
        } },
        window: {
            onDidChangeActiveTextEditor: () => disposable(),
            onDidChangeTextEditorSelection: () => disposable(),
            onDidChangeWindowState: () => disposable(),
            createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
            registerUriHandler(handler: { handleUri(uri: Uri): Promise<void> }) {
                assert.equal(uriHandler, undefined, 'one URI handler per activation');
                uriHandler = handler;
                return { dispose() { uriHandler = undefined; } };
            },
            async showTextDocument(document: vscode.TextDocument, options: { selection: Range }) {
                opened.push({ document, selection: options.selection });
            },
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
    const publicationPath = require.resolve('../../publication-extension');
    const previousPublication = require.cache[publicationPath];
    let extension: typeof import('../../extension');
    try {
        delete require.cache[extensionPath];
        delete require.cache[publicationPath];
        loader._load = function (request, parent, isMain) {
            if ((request === 'fs/promises' || request === 'node:fs/promises') && parent?.filename === extensionPath) {
                // Only the extension's mode operations are mocked; never touch real /project files.
                return {
                    async lstat(filePath: string) {
                        const key = Uri.file(filePath).toString();
                        modeStats.push(key);
                        const type = entryType(key);
                        if (type === undefined) { throw new FileSystemError('FileNotFound'); }
                        return { mode: 0o100000 | (modes.get(key) ?? 0o644),
                            isFile: () => type === fileType.File,
                            isSymbolicLink: () => !!(type & fileType.SymbolicLink) };
                    },
                    async chmod(filePath: string, mode: number) {
                        const key = Uri.file(filePath).toString();
                        if (controls.chmodError) { throw new FileSystemError(controls.chmodError); }
                        assert.equal(entryType(key), fileType.File);
                        modes.set(key, mode);
                        modeChanges.push({ uri: key, mode });
                    }
                };
            }
            return request === 'vscode' ? mock : originalLoad.call(this, request, parent, isMain);
        };
        extension = require(extensionPath) as typeof import('../../extension');
    } finally {
        loader._load = originalLoad;
        if (previousModule) { require.cache[extensionPath] = previousModule; }
        else { delete require.cache[extensionPath]; }
        if (previousPublication) { require.cache[publicationPath] = previousPublication; }
        else { delete require.cache[publicationPath]; }
    }
    const repository = new extension.FragmentRepository({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const uri = (name: string, base = folder) => Uri.joinPath(base.uri, name).toString();
    const put = (name: string, content: string, base = folder) => {
        const key = uri(name, base);
        disk.set(key, Buffer.from(content));
        if (!modes.has(key)) { modes.set(key, 0o644); }
    };
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
    return { folder, other, disk, modes, modeStats, modeChanges, types, statErrors, stats, listings, diagnostics, reads, writes, stagedWrites, renames, deletions, directories, errors, controls,
        workspace, repository, extension, mock, providers, commands, executedCommands, document, open, uri, put, change, process,
                opened, externalUris, navigate: async (href: string) => uriHandler?.handleUri(Uri.parse(href)),
                        workspaceChanged: () => workspaceEvents.fire({ added: [], removed: [folder] }),
        fileEvent(kind: keyof typeof fileEvents, name: string, base = folder) {
            fileEvents[kind].fire(Uri.joinPath(base.uri, name));
        },
        get docs() { return workspace.textDocuments; }, discoveries: () => discoveries };
}
