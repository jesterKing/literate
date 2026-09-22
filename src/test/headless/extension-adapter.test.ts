/* Mocks preserve VS Code's public API names; fixture keys are filesystem paths. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { generateProject, SourceDocument } from '../../engine';

import { fixture, fence, root, tick } from './vscode-fixture';

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

for (const unsafe of [
    { name: 'linked leaf', target: 'generated/main.txt', type: 1 | 64 },
    { name: 'linked ancestor', target: 'generated', type: 2 | 64 },
    { name: 'bare link', target: 'generated/main.txt', type: 64 },
    { name: 'dangling leaf', target: 'generated/main.txt', type: 64, dangling: true },
    { name: 'dangling ancestor', target: 'generated', type: 2 | 64, dangling: true },
    { name: 'file parent', target: 'generated', type: 1 },
    { name: 'unknown parent', target: 'generated', type: 0 },
    { name: 'directory output', target: 'generated/main.txt', type: 2 },
    { name: 'unknown output', target: 'generated/main.txt', type: 0 },
    { name: 'special output', target: 'generated/main.txt', type: 128 },
    { name: 'combined non-link output', target: 'generated/main.txt', type: 1 | 2 },
    { name: 'late unsafe HTML output', target: 'index.html', type: 2 | 64 }
]) {
    test(`output preflight rejects ${unsafe.name} before any output reads or writes`, { timeout: 5000 }, async () => {
        const f = fixture();
        const text = root('hello');
        f.put('index.literate', text);
        const files = expected([{ path: 'index.literate', text }]);
        for (const file of files) { f.put(file.path, file.content); }
        f.types.set(f.uri(unsafe.target), unsafe.type);
        if (unsafe.dangling) { f.statErrors.set(f.uri(unsafe.target), 'FileNotFound'); }
        const before = new Map(f.disk);
        await assert.rejects(f.process(true), /Unsafe output path/);
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.directories, []);
        assert.deepEqual(f.disk, before);
        for (const file of files) {
            assert.ok(!f.reads.includes(f.uri(file.path)), `preflight must precede reading ${file.path}`);
        }
        assert.ok(!f.stats.includes(f.folder.uri.toString()), 'workspace root is the trusted boundary');
        if (unsafe.dangling) {
            const parent = f.mock.Uri.joinPath(f.mock.Uri.parse(f.uri(unsafe.target)), '..').toString();
            assert.ok(f.listings.includes(parent), 'missing stat must check directory entries');
        }
    });
}

test('late unsafe output blocks earlier changed and missing outputs', { timeout: 5000 }, async () => {
    for (const existing of [false, true]) {
        const f = fixture();
        const text = root('new');
        f.put('index.literate', text);
        const files = expected([{ path: 'index.literate', text }]);
        assert.equal(files.at(-1)?.path, 'index.html', 'unsafe output must be last in generation order');
        if (existing) { f.put('generated/main.txt', 'old'); }
        f.types.set(f.uri('index.html'), f.mock.FileType.Directory);
        const before = new Map(f.disk);
        await assert.rejects(f.process(true), /Unsafe output path/);
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.directories, []);
        assert.deepEqual(f.disk, before);
        assert.ok(!f.reads.includes(f.uri('generated/main.txt')));
    }
});

test('read-only refresh bypasses output preflight even with unsafe outputs', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('hello'));
    f.types.set(f.uri('generated'), f.mock.FileType.SymbolicLink | f.mock.FileType.Directory);
    for (const writeFiles of [undefined, false]) { await f.process(writeFiles); }
    assert.deepEqual(f.stats, []);
    assert.deepEqual(f.listings, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.directories, []);
    assert.ok(!f.reads.includes(f.uri('generated/main.txt')));
    assert.ok(!f.reads.includes(f.uri('index.html')));
});

test('output stat permission errors propagate and the queue recovers', { timeout: 5000 }, async () => {
    const f = fixture();
    f.put('index.literate', root('hello'));
    f.statErrors.set(f.uri('index.html'), 'NoPermissions');
    await assert.rejects(f.process(true), /NoPermissions/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.directories, []);
    assert.deepEqual(f.listings, [f.folder.uri.toString()], 'permission failure must not use missing-entry fallback');
    assert.ok(!f.reads.includes(f.uri('generated/main.txt')));
    assert.match(f.errors[0], /NoPermissions/);
    f.statErrors.clear();
    await f.process(true);
    assertOutputs(f, expected([{ path: 'index.literate', text: root('hello') }]));
});

test('nested remote outputs use the workspace provider and skip unchanged bytes', { timeout: 5000 }, async () => {
    const f = fixture('vscode-remote://example/project');
    const text = fence('text: <<main.*>>= nested/deeper/main.txt $', 'remote');
    f.put('index.literate', text);
    f.types.set(f.uri('nested'), f.mock.FileType.Directory);
    await f.process(true);
    assertOutputs(f, expected([{ path: 'index.literate', text }]));
    assert.ok(f.stats.includes(f.uri('nested/deeper')));
    assert.ok(!f.stats.includes(f.uri('nested/deeper/main.txt')), 'stop at the first absent component');
    assert.ok([...f.stats, ...f.listings, ...f.writes].every(uri => uri.startsWith('vscode-remote://example/')));
    f.writes.length = 0;
    f.directories.length = 0;
    await f.process(true);
    assert.ok(f.stats.includes(f.uri('nested/deeper/main.txt')));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.directories, []);
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
