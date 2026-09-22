/* Mocks preserve VS Code's public API names; fixture keys are filesystem paths. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { generateProject, SourceDocument } from '../../engine';

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

class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(line: number, column: number, endLine: number, endColumn: number) {
        this.start = { line, character: column };
        this.end = { line: endLine, character: endColumn };
    }
}

class Diagnostic {
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const disposable = () => ({ dispose() {} });
const fence = (header: string, content = '') => '```' + header + '\n' + content
    + (content && !content.endsWith('\n') ? '\n' : '') + '```\n';
const root = (content: string, settings = '') =>
    fence('text: <<main.*>>= generated/main.txt $ ' + settings, content);

function fixture() {
    const folder = { name: 'project', uri: Uri.file('/project'), index: 0 };
    const other = { name: 'other', uri: Uri.file('/other'), index: 1 };
    const disk = new Map<string, Buffer>();
    const diagnostics = new Map<string, Diagnostic[]>();
    const reads: string[] = [], writes: string[] = [], directories: string[] = [], errors: string[] = [];
    let discoveries = 0;
    let onChange: (event: vscode.TextDocumentChangeEvent) => Promise<void> = async () => {};
    const controls: { beforeWrite?: () => Promise<void>; readError?: string } = {};
    const document = (name: string, text: string, base = folder): vscode.TextDocument => ({
        uri: Uri.joinPath(base.uri, name), eol: 1, getText: () => text
    } as unknown as vscode.TextDocument);
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
        onDidChangeTextDocument(callback: typeof onChange) { onChange = callback; return disposable(); },
        onDidChangeWorkspaceFolders() { return disposable(); },
        async findFiles(_pattern: unknown, exclude: unknown) {
            assert.equal(exclude, null, 'discovery must not apply editor search exclusions');
            discoveries++;
            await tick();
            return [...disk.keys()].filter(key => key.startsWith(folder.uri.toString() + '/')
                && key.endsWith('.literate')).reverse().map(Uri.parse);
        },
        fs: {
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
    const mock = {
        Uri, FileSystemError, Range, Diagnostic, DiagnosticSeverity: { Error: 0 },
        TreeItem: class {}, RelativePattern: class {}, workspace,
        languages: { createDiagnosticCollection: () => collection },
        window: { showErrorMessage: (message: string) => { errors.push(message); } }
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
    const uri = (name: string) => Uri.joinPath(folder.uri, name).toString();
    const put = (name: string, content: string) => { disk.set(uri(name), Buffer.from(content)); };
    async function change(doc: vscode.TextDocument, text = 'changed', contentChanges = true): Promise<void> {
        await onChange({
            document: doc, contentChanges: contentChanges ? [{ text }] : []
        } as unknown as vscode.TextDocumentChangeEvent);
    }
    const process = (writeFiles?: boolean) => repository.processLiterateFiles(
        folder as unknown as vscode.WorkspaceFolder, writeFiles);
    return { folder, other, disk, diagnostics, reads, writes, directories, errors, controls,
        workspace, repository, document, uri, put, change, process, discoveries: () => discoveries };
}

function expected(documents: SourceDocument[], templates: Record<string, string> = {}) {
    const result = generateProject(documents, templates);
    assert.deepEqual(result.diagnostics, []);
    return result.files;
}

function assertOutputs(f: ReturnType<typeof fixture>, files: ReturnType<typeof expected>): void {
    assert.deepEqual([...f.writes].sort(), files.map(file => f.uri(file.path)).sort());
    for (const file of files) {
        assert.deepEqual(f.disk.get(f.uri(file.path)), Buffer.from(file.content), file.path);
    }
}

test('adapter matches engine source and HTML using buffers, all chapters, and both templates', { timeout: 5000 }, async () => {
    const f = fixture();
    const index = '[B](b.html)\n' + fence('SETTINGS', 'template=page.template\nauthors=Buffer Author')
        + root('<<piece>>', 'template=source.template') + fence('text: <<piece>>=');
    const documents = [
        { path: 'index.literate', text: index },
        { path: 'a.literate', text: fence('text: <<piece>>=+', 'a') },
        { path: 'b.literate', text: fence('text: <<piece>>=+', 'b') },
        { path: 'empty.literate', text: '' },
        { path: 'new.literate', text: '# New unsaved chapter' }
    ];
    f.put('index.literate', 'stale index');
    f.put('a.literate', documents[1].text);
    f.put('b.literate', documents[2].text);
    f.put('empty.literate', root('<<missing>>'));
    f.put('source.template', 'stale source [CODE]');
    f.put('page.template', 'stale HTML [CONTENT]');
    const templates = { 'source.template': 'buffer:[CODE]', 'page.template': '[AUTHORS]<main>[CONTENT]</main>' };
    f.workspace.textDocuments = [
        f.document('index.literate', 'wrong workspace', f.other),
        f.document('index.literate', index), f.document('empty.literate', ''),
        f.document('new.literate', documents[4].text),
        ...Object.entries(templates).map(([name, text]) => f.document(name, text))
    ];
    await f.process();
    assert.deepEqual(f.writes, [], 'default/completion refresh is read-only');
    assert.deepEqual(f.directories, []);
    const workspace = f.folder as unknown as vscode.WorkspaceFolder;
    assert.equal(f.repository.getFragments(workspace).map.get('piece')?.code, 'b\na\n');
    assert.deepEqual(f.repository.getWorkspaceState(workspace).list.map(state => state.literateFileName),
        ['index.literate', 'b.literate', 'a.literate', 'empty.literate', 'new.literate']);
    await f.process(true);
    const files = expected(documents, templates);
    assert.ok(files.some(file => file.path === 'generated/main.txt'));
    assert.equal(files.filter(file => file.path.endsWith('.html')).length, documents.length);
    assertOutputs(f, files);
    for (const name of ['index.literate', 'empty.literate', 'new.literate', ...Object.keys(templates)]) {
        assert.ok(!f.reads.includes(f.uri(name)), `buffer must prevent disk read: ${name}`);
    }
});

test('discovery ignores duplicate vendor fragments on disk and in buffers using CLI exclusions', { timeout: 5000 }, async () => {
    const f = fixture();
    const documents = [
        { path: 'index.literate', text: root('project code') },
        { path: 'docs/node_modules.literate', text: '# Filename, not a directory' },
        { path: 'outtakes/chapter.literate', text: '# Similar directory name' },
        { path: 'nested/dist-not/chapter.literate', text: '# Nested similar name' }
    ];
    for (const document of documents) { f.put(document.path, document.text); }
    const ignored: string[] = [];
    for (const directory of ['node_modules', 'out', 'dist', '.git', '.yarn', '.vscode-test']) {
        for (const prefix of ['', 'nested/']) {
            const diskPath = `${prefix}${directory}/vendor.literate`;
            const bufferPath = `${prefix}${directory}/unsaved.literate`;
            f.put(diskPath, root('duplicate vendor fragment'));
            f.workspace.textDocuments.push(f.document(bufferPath, root('duplicate unsaved vendor fragment')));
            ignored.push(diskPath, bufferPath);
        }
    }
    await f.process(true);
    assert.equal(f.diagnostics.size, 0, 'excluded duplicates must not invalidate the project');
    assertOutputs(f, expected(documents));
    for (const name of ignored) {
        assert.ok(!f.reads.includes(f.uri(name)), `excluded document must not be read: ${name}`);
        assert.ok(!f.disk.has(f.uri(name.replace(/\.literate$/, '.html'))),
            `excluded document must not produce HTML: ${name}`);
    }
    const workspace = f.folder as unknown as vscode.WorkspaceFolder;
    assert.deepEqual(f.repository.getWorkspaceState(workspace).list.map(state => state.literateFileName).sort(),
        documents.map(document => document.path).sort());
});

test('adapter skips unchanged files and rewrites only changed disk output', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('hello'));
    await f.process(true);
    assertOutputs(f, expected([{ path: 'index.literate', text: root('hello') }]));
    f.writes.length = 0;
    f.directories.length = 0;
    await f.process(true);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.directories, []);
    f.put('generated/main.txt', 'outdated');
    // Output comparison must use disk, not an editor buffer that happens to match.
    f.workspace.textDocuments = [f.document('generated/main.txt', 'hello\n')];
    await f.process(true);
    assert.deepEqual(f.writes, [f.uri('generated/main.txt')]);
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'hello\n');
});

test('invalid projects preserve existing outputs and map engine diagnostics without offset changes', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('valid'));
    await f.process(true);
    const before = new Map(f.disk);
    const invalid = [root('  <<missing>>'), root('ok', 'template=missing.template'),
        root('ok', 'template=../outside.template'), root('<<loop>>') + fence('text: <<loop>>=', '<<loop>>')];
    for (const text of invalid) {
        f.workspace.textDocuments = [f.document('index.literate', text)];
        f.writes.length = 0;
        f.directories.length = 0;
        await f.process(true);
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.directories, []);
        assert.deepEqual(f.disk, before, 'neither source nor HTML may change on validation failure');
        const result = generateProject([{ path: 'index.literate', text }]);
        assert.ok(result.diagnostics.length > 0);
        assert.deepEqual(f.diagnostics.get(f.uri('index.literate'))?.map(diagnostic => ({
            path: 'index.literate', line: diagnostic.range.start.line,
            column: diagnostic.range.start.character, message: diagnostic.message
        })), result.diagnostics);
        for (const diagnostic of f.diagnostics.get(f.uri('index.literate')) || []) {
            assert.equal(diagnostic.severity, 0);
            assert.equal(diagnostic.range.end.character, diagnostic.range.start.character + 1);
        }
    }
    assert.ok(!f.reads.some(uri => uri.includes('outside.template')), 'unsafe templates must never be read');
    f.workspace.textDocuments = [];
    await f.process(true);
    assert.equal(f.diagnostics.size, 0, 'fixed inputs clear stale diagnostics');
    assert.deepEqual(f.errors, [], 'missing templates are diagnostics, not I/O popups');
});

test('empty unsaved templates are loaded rather than replaced by disk or treated as missing', { timeout: 5000 }, async () => {
    const f = fixture();
    const text = fence('SETTINGS', 'template=page.template') + root('code', 'template=source.template');
    f.put('index.literate', text);
    f.put('source.template', 'disk [CODE]');
    // The page template exists only as a new file-backed editor buffer.
    f.workspace.textDocuments = [f.document('source.template', ''), f.document('page.template', '')];
    await f.process(true);
    assertOutputs(f, expected([{ path: 'index.literate', text }], { 'source.template': '', 'page.template': '' }));
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.length, 0);
    assert.equal(f.disk.get(f.uri('index.html'))?.length, 0);
    assert.equal(f.diagnostics.size, 0);
});

test('adapter ignores nonliterate and metadata changes but processes opening chevrons', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('old'));
    await f.change(f.document('generated/main.txt', 'source'));
    await f.change(f.document('index.html', 'HTML'));
    await f.change(f.document('index.literate', 'unchanged'), '', false);
    assert.equal(f.discoveries(), 0);
    const text = root('<');
    f.workspace.textDocuments = [f.document('index.literate', text)];
    await f.change(f.workspace.textDocuments[0], '<');
    assertOutputs(f, expected([{ path: 'index.literate', text }]));
    assert.equal(f.discoveries(), 1, 'generated source/HTML events must not reenter processing');
});

test('processing is serialized through awaited writes and recovers after I/O failure', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('queued'));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    f.controls.beforeWrite = async () => { entered(); await gate; };
    let firstFinished = false;
    const first = f.process(true).then(() => { firstFinished = true; });
    await writing;
    const second = f.process(true);
    try {
        await tick();
        assert.equal(firstFinished, false, 'processing promise must await writes');
        assert.equal(f.discoveries(), 1, 'second request must wait for the first write to finish');
    } finally {
        release();
        await Promise.all([first, second]);
    }
    assert.equal(f.discoveries(), 2);
    assertOutputs(f, expected([{ path: 'index.literate', text: root('queued') }]));
    f.controls.beforeWrite = undefined;
    f.controls.readError = 'NoPermissions';
    await assert.rejects(f.process(true), /NoPermissions/);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /NoPermissions/);
    f.controls.readError = undefined;
    f.writes.length = 0;
    await f.process(true);
    assert.deepEqual(f.writes, [], 'recovered queue still skips unchanged files');
});
