import assert = require('node:assert/strict');
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { fixture, fence, root, Position } from './vscode-fixture';

type Fixture = ReturnType<typeof fixture>;
const token = (isCancellationRequested = false) => ({
    isCancellationRequested, onCancellationRequested: () => ({ dispose() {} })
} as vscode.CancellationToken);
const folder = (f: Fixture) => f.folder as unknown as vscode.WorkspaceFolder;
const at = (doc: vscode.TextDocument, needle: string, occurrence = 0, inner = 2) => {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) { offset = doc.getText().indexOf(needle, offset + 1); }
    assert.ok(offset >= 0, `missing occurrence ${occurrence} of ${needle}`);
    return doc.positionAt(offset + inner);
};
const coordinates = (range: vscode.Range) => [range.start.line, range.start.character, range.end.line, range.end.character];
const renameProvider = (f: Fixture): vscode.RenameProvider => new f.extension.LiterateRenameProvider(f.repository);
async function rename(f: Fixture, doc: vscode.TextDocument, name = 'renamed', position = at(doc, '<<foo>>'), cancelled = false) {
    return await renameProvider(f).provideRenameEdits(doc, position, name, token(cancelled));
}
function noEdits(edit: vscode.WorkspaceEdit | null | undefined): void {
    assert.equal(edit?.entries().flatMap(([, edits]) => edits).length || 0, 0);
}
function readOnly(f: Fixture): void {
    assert.deepEqual(f.writes, [], 'symbol operations must not generate files');
    assert.deepEqual(f.directories, [], 'symbol operations must not create output directories');
}
function apply(doc: vscode.TextDocument, edit: vscode.WorkspaceEdit): string {
    let text = doc.getText();
    const edits = edit.get(doc.uri).map(e => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.newText }));
    edits.sort((a, b) => b.start - a.start);
    let boundary = text.length;
    for (const e of edits) {
        assert.ok(e.end <= boundary, 'edits must not overlap');
        text = text.slice(0, e.start) + e.text + text.slice(e.end);
        boundary = e.start;
    }
    return text;
}

// The interface allows this contract suite to compile before the optional argument lands.
function references(f: Fixture, includeDeclaration = false) {
    const repository = f.repository as unknown as {
        getReferenceLocations(folder: vscode.WorkspaceFolder, name: string, includeDeclaration?: boolean): vscode.Location[];
    };
    return repository.getReferenceLocations(folder(f), 'foo', includeDeclaration);
}

test('tag lookup returns full and inner ranges for declarations, repeated references and prose', async () => {
    const f = fixture();
    const doc = f.open('index.literate', fence('text: <<foo>>=', 'body') + root('<<foo>> <<foo>>')
        + '# 😀 <<foo>> and <<foo>>\n- nested **<<foo>>**\n' + fence('text: <<foo>>=+', 'append'));
    await f.process();
    for (let i = 0; i < 7; i++) {
        const position = at(doc, '<<foo>>', i);
        const location = f.repository.getFragmentTagLocation(doc, doc.lineAt(position), position);
        assert.equal(location.name, 'foo');
        assert.equal(location.valid, true);
        assert.equal(doc.getText(location.range), '<<foo>>');
        assert.equal(doc.getText(location.rangeExclusive), 'foo');
        assert.equal(doc.offsetAt(location.range.start), doc.offsetAt(position) - 2);
        assert.ok(location.fragment);
    }
    readOnly(f);
});

test('lookup ignores bare names, escaped tags and ordinary code fences', async () => {
    const f = fixture();
    const doc = f.open('index.literate', fence('text: <<foo>>=', 'body')
        + 'bare foo and foobar; \\<<foo>>\n' + fence('text', '<<foo>>'));
    await f.process();
    for (const position of [at(doc, 'bare foo', 0, 6), at(doc, '<<foo>>', 1), at(doc, '<<foo>>', 2)]) {
        assert.equal(f.repository.getFragmentTagLocation(doc, doc.lineAt(position), position).valid, false);
        noEdits(await rename(f, doc, 'renamed', position));
    }
    readOnly(f);
});

test('rename changes only symbol names in declarations, appends, code references and explicit prose across documents', async () => {
    const f = fixture();
    const first = fence('text: <<foo>>=', 'foo body') + root('<<foo>> <<foo>> <<foobar>> \\<<foo>>')
        + 'foo foobar <<foo>> <<foo>> \\<<foo>>\n' + fence('text', '<<foo>>') + fence('text: <<foobar>>=', 'other');
    const second = fence('text: <<foo>>=+', 'append foo') + 'Mention <<foo>>.\n';
    const a = f.open('foo.literate', first);
    const b = f.open('chapter.literate', second);
    f.put('foo.literate', 'stale disk foo');
    f.put('chapter.literate', second);
    const before = new Map(f.disk);
    const edit = await rename(f, a);
    assert.ok(edit);
    assert.equal(edit.entries().length, 2);
    assert.equal(edit.get(a.uri).length, 5);
    assert.equal(edit.get(b.uri).length, 2);
    for (const doc of [a, b]) {
        for (const replacement of edit.get(doc.uri)) {
            assert.equal(doc.getText(replacement.range), 'foo');
            assert.equal(replacement.newText, 'renamed');
        }
    }
    assert.equal(apply(a, edit), fence('text: <<renamed>>=', 'foo body')
        + root('<<renamed>> <<renamed>> <<foobar>> \\<<foo>>')
        + 'foo foobar <<renamed>> <<renamed>> \\<<foo>>\n' + fence('text', '<<foo>>') + fence('text: <<foobar>>=', 'other'));
    assert.equal(apply(b, edit), fence('text: <<renamed>>=+', 'append foo') + 'Mention <<renamed>>.\n');
    assert.deepEqual(f.disk, before, 'provider returns edits without applying or generating them');
    assert.equal(a.uri.toString(), f.uri('foo.literate'));
    readOnly(f);
});

test('prepareRename returns the inner name and refreshes unsaved buffers', async () => {
    const f = fixture();
    f.put('index.literate', fence('text: <<old>>=', 'disk'));
    await f.process();
    const doc = f.open('index.literate', '# fresh\n' + fence('text: <<foo>>=', 'buffer') + 'See <<foo>>.\n');
    const provider = renameProvider(f);
    assert.equal(typeof provider.prepareRename, 'function');
    const prepared = await provider.prepareRename!(doc, at(doc, '<<foo>>', 1), token());
    assert.ok(prepared);
    const range = 'range' in prepared ? prepared.range : prepared;
    assert.equal(doc.getText(range), 'foo');
    assert.equal(doc.offsetAt(range.start), doc.getText().lastIndexOf('<<foo>>') + 2);
    const next = f.open('index.literate', doc.getText() + 'New <<foo>>.\n');
    assert.ok(next.version > doc.version);
    const edit = await rename(f, next);
    assert.ok(edit);
    assert.equal(edit.get(next.uri).length, 3);
    assert.ok(!f.reads.slice(1).includes(f.uri('index.literate')), 'fresh buffer replaces disk reads');
    readOnly(f);
});

for (const newName of ['', ' ', ' foo', 'foo ', 'bad\nname', 'bad\rname', 'a<b', 'a>b', 'foo.*', 'taken']) {
    test(`rename rejects invalid, root-changing or colliding name ${JSON.stringify(newName)}`, async () => {
        const f = fixture();
        const doc = f.open('index.literate', fence('text: <<foo>>=', 'one') + fence('text: <<taken>>=', 'two'));
        await assert.rejects(async () => { await rename(f, doc, newName); },
            (error: unknown) => error instanceof Error && !(error instanceof TypeError));
        readOnly(f);
    });
}

test('root rename preserves .* and output filenames, and cannot become a non-root', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('code') + 'See <<main.*>>.\n');
    const edit = await rename(f, doc, 'entry.*', at(doc, '<<main.*>>'));
    assert.ok(edit);
    assert.equal(apply(doc, edit), doc.getText().replaceAll('<<main.*>>', '<<entry.*>>'));
    await assert.rejects(async () => { await rename(f, doc, 'entry', at(doc, '<<main.*>>')); });
    readOnly(f);
});

test('unchanged names and cancelled requests return no edits', async () => {
    const f = fixture();
    const doc = f.open('index.literate', fence('text: <<foo>>=', 'body') + root('<<foo>>'));
    noEdits(await rename(f, doc, 'foo'));
    noEdits(await rename(f, doc, 'renamed', at(doc, '<<foo>>'), true));
    const provider = renameProvider(f);
    assert.equal(typeof provider.prepareRename, 'function');
    assert.equal(await provider.prepareRename!(doc, at(doc, '<<foo>>'), token(true)), null);
    readOnly(f);
});

test('unknown fragments cannot be renamed even when explicitly mentioned', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<foo>>') + 'Mention <<foo>>.\n');
    // Rejection or a null/empty result are both valid ways to decline an unresolved symbol.
    let result: vscode.WorkspaceEdit | null | undefined;
    try { result = await rename(f, doc); } catch (error) {
        assert.ok(error instanceof Error && !(error instanceof TypeError), 'decline unresolved symbols without crashing');
    }
    noEdits(result);
    readOnly(f);
});

test('prepareRename declines ordinary text and unresolved mentions', async () => {
    const f = fixture();
    const doc = f.open('index.literate', 'ordinary text\nMention <<unknown>>.\n');
    const provider = renameProvider(f);
    assert.equal(typeof provider.prepareRename, 'function');
    for (const position of [doc.positionAt(0), at(doc, '<<unknown>>')]) {
        try {
            const prepared = await provider.prepareRename!(doc, position, token());
            assert.ok(prepared === null || prepared === undefined, 'only defined fragment names can be prepared');
        } catch (error) {
            assert.ok(error instanceof Error && !(error instanceof TypeError) && !(error instanceof assert.AssertionError));
        }
    }
    readOnly(f);
});

test('unrelated diagnostics do not block a valid rename', async () => {
    const f = fixture();
    const doc = f.open('index.literate', fence('text: <<foo>>=', 'body') + root('<<missing>> <<foo>>'));
    await f.process();
    assert.ok(f.diagnostics.size > 0);
    const edit = await rename(f, doc);
    assert.ok(edit);
    assert.equal(edit.get(doc.uri).length, 2);
    readOnly(f);
});

test('nested markdown, headings, CRLF and Unicode retain exact UTF-16 ranges', async () => {
    const f = fixture();
    const text = '# 😀 <<foo>>\r\n\r\n- item\r\n  - é <<foo>> and <<foo>>\r\n\r\n'
        + '> ```text: <<foo>>=\r\n> body\r\n> ```\r\n';
    const doc = f.open('index.literate', text);
    const edit = await rename(f, doc);
    assert.ok(edit);
    assert.deepEqual(edit.get(doc.uri).map(e => coordinates(e.range)).sort(),
        [[0, 7, 0, 10], [3, 8, 3, 11], [3, 20, 3, 23], [5, 13, 5, 16]].sort());
    assert.equal(apply(doc, edit), text.replaceAll('<<foo>>', '<<renamed>>'));
    readOnly(f);
});

test('references include repeated code and prose mentions and honor includeDeclaration', async () => {
    const f = fixture();
    const doc = f.open('index.literate', fence('text: <<foo>>=', 'body') + fence('text: <<foo>>=+', 'append')
        + root('<<foo>> <<foo>>') + '# <<foo>> and <<foo>>\n' + '\\<<foo>>\n' + fence('text', '<<foo>>'));
    await f.process();
    const expected = (indices: number[]) => indices.map(i => {
        const p = at(doc, '<<foo>>', i, 0);
        return [p.line, p.character, p.line, p.character + 7];
    }).sort();
    const check = (locations: vscode.Location[], indices: number[]) => {
        assert.ok(locations.every(location => location.uri.toString() === doc.uri.toString()));
        assert.deepEqual(locations.map(location => coordinates(location.range)).sort(), expected(indices));
    };
    check(await references(f), [2, 3, 4, 5]);
    check(await references(f, true), [0, 1, 2, 3, 4, 5]);
    const provider = new f.extension.LiterateReferenceProvider(f.repository);
    for (const includeDeclaration of [false, true]) {
        const locations = await provider.provideReferences(doc, at(doc, '<<foo>>', 3), { includeDeclaration }, token());
        assert.ok(locations);
        check(locations, includeDeclaration ? [0, 1, 2, 3, 4, 5] : [2, 3, 4, 5]);
    }
    readOnly(f);
});

test('hover and definition choose the second repeated tag, not a greedy combined name', async () => {
    const f = fixture();
    const definition = f.open('definition.literate', fence('text: <<foo>>=', 'unique body'));
    const doc = f.open('index.literate', root('<<foo>> <<foo>>'));
    const position = at(doc, '<<foo>>', 1);
    const hover = await new f.extension.FragmentHoverProvider(f.repository).provideHover(doc, position, token());
    assert.ok(hover?.range);
    assert.equal(doc.offsetAt(hover.range.start), doc.getText().lastIndexOf('<<foo>>'));
    assert.equal(doc.getText(hover.range), '<<foo>>');
    assert.match((hover.contents[0] as vscode.MarkdownString).value, /unique body/);
    const location = await new f.extension.LiterateDefinitionProvider(f.repository).provideDefinition(doc, position, token());
    assert.ok(location);
    assert.equal(location.uri.toString(), definition.uri.toString());
    assert.equal(location.range.start.line, 0);
    readOnly(f);
});

test('folders with the same display name never share symbol state or rename edits', async () => {
    const f = fixture();
    f.other.name = f.folder.name;
    f.workspace.workspaceFolders.push(f.other);
    const a = f.open('index.literate', fence('text: <<foo>>=', 'project body'));
    const b = f.open('index.literate', fence('text: <<foo>>=', 'other body'), f.other);
    f.put('index.literate', b.getText(), f.other);
    await f.repository.processLiterateFiles(f.other as unknown as vscode.WorkspaceFolder);
    const edit = await rename(f, a);
    assert.ok(edit);
    assert.deepEqual(edit.entries().map(([uri]) => uri.toString()), [a.uri.toString()]);
    assert.equal(edit.get(b.uri).length, 0);
    const info = f.repository.getFragmentTagLocation(a, a.lineAt(0), at(a, '<<foo>>'));
    assert.equal(info.fragment?.env.literateUri.toString(), a.uri.toString());
    readOnly(f);
});

test('tree children scan separate unescaped tags and navigate to the child definition', async () => {
    const f = fixture();
    f.open('index.literate', root('<<foo>> <<bar>> \\<<foo>>'));
    const child = f.open('child.literate', fence('text: <<foo>>=', 'foo') + fence('text: <<bar>>=', 'bar'));
    await f.process();
    const providerConstructor = f.extension.FragmentNodeProvider as unknown as new (repository: typeof f.repository) => InstanceType<typeof f.extension.FragmentNodeProvider>;
    const provider = new providerConstructor(f.repository);
    const workspaces = await provider.getChildren();
    const fragments = await provider.getChildren(workspaces[0]);
    const parent = fragments.find(node => node.label === 'main.*');
    assert.ok(parent);
    const children = await provider.getChildren(parent);
    assert.deepEqual(children.map(node => node.label), ['foo', 'bar']);
    for (const [index, node] of children.entries()) {
        assert.equal(node.command?.arguments?.[0].toString(), child.uri.toString());
        assert.equal(node.command?.arguments?.[1].selection.start.line, index * 3);
    }
    readOnly(f);
});

test('fixture snapshots support both range overloads and position lineAt without vscode runtime imports', () => {
    const f = fixture();
    const doc = f.open('index.literate', '😀foo\r\nbar');
    const next = f.open('index.literate', 'changed');
    assert.equal(doc.getText(), '😀foo\r\nbar');
    assert.ok(next.version > doc.version);
    assert.equal(doc.lineAt(new Position(1, 0) as vscode.Position).text, 'bar');
    assert.equal(doc.getText(new f.mock.Range(0, 2, 0, 5) as vscode.Range), 'foo');
    assert.equal(doc.getText(new f.mock.Range(new Position(1, 0), new Position(1, 3)) as vscode.Range), 'bar');
});
