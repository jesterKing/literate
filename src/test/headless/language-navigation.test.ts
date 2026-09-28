/* Protocol and VS Code API spellings are intentional. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type * as vscode from 'vscode';
import { generateProject, SourceDocument } from '../../engine';
import { projectLanguageSources } from '../../language-projection';
import type { LanguageLocationContext } from '../../language-navigation';
import { Position, Range } from './vscode-fixture';

const root = path.resolve(__dirname, '../../..');
const chapter = fs.readFileSync(path.join(root, 'literate/language-navigation.literate'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/language-navigation.ts'), 'utf8');
class Uri {
    constructor(private readonly value: URL) {}
    get fsPath() { return fileURLToPath(this.value); }
    get scheme() { return this.value.protocol.slice(0, -1); }
    get authority() { return this.value.host; }
    get query() { return this.value.search.slice(1); }
    get fragment() { return this.value.hash.slice(1); }
    toString() { return this.value.toString(); }
    static parse(value: string) { return new Uri(new URL(value)); }
    static file(value: string) { return new Uri(pathToFileURL(value)); }
}
class Location { constructor(readonly uri: Uri, readonly range: Range) {} }
const exported: Partial<typeof import('../../language-navigation')> = {};
new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText)((name: string) => {
    if (name === 'vscode') { return { Uri, Position, Range, Location }; }
    assert.equal(name, 'node:path', 'mapper must not import filesystem or session services');
    return path;
}, exported);
const navigate = exported.mapLanguageLocations!;
const diagnose = exported.mapLanguageDiagnosticRange!;
const point = (line: number, character: number) => ({ line, character });
const range = (line: number, start: number, end: number, endLine = line) => ({ start: point(line, start), end: point(endLine, end) });
const fence = (header: string, body: string) => '```' + header + '\n' + body + '\n```\n';
const uri = 'file:///project/main.ts';
function context(documents: SourceDocument[], templates: Record<string, string> = {}): LanguageLocationContext {
    const projected = projectLanguageSources(documents, templates);
    assert.deepEqual(projected.diagnostics, []);
    return { root: Uri.file('/project') as unknown as vscode.Uri, files: projected.files, documents };
}
const simple = () => context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', 'const value = 1;\nvalue;') }]);
const values = (locations: vscode.Location[]) => locations.map(value => [value.uri.toString(),
    value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character]);

test('owned chapter assembles exactly, with bounded design fragments', () => {
    const generated = generateProject([{ path: 'literate/language-navigation.literate', text: chapter }]);
    assert.deepEqual(generated.diagnostics, []);
    assert.equal(generated.files.find(file => file.path === 'src/language-navigation.ts')?.content, source);
    for (const match of chapter.matchAll(/```ts[^\n]*\n([\s\S]*?)\n```/g)) {
        assert.ok(match[1].split('\n').length <= 30);
    }
});

test('single and array locations map cross-file symbols and preserve imported library paths', () => {
    const state = context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', '<<symbol>>') },
        { path: 'other.literate', text: fence('ts: <<symbol>>=', 'const symbol = 1;') }]);
    const reply = { uri, range: range(0, 6, 12) };
    assert.deepEqual(values(navigate(reply, state)), [['file:///project/other.literate', 1, 6, 1, 12]]);
    const external = { uri: 'file:///libs/imported.d.ts', range: range(45, 2, 8) };
    assert.deepEqual(values(navigate([reply, reply, external], state)), [
        ['file:///project/other.literate', 1, 6, 1, 12], ['file:///libs/imported.d.ts', 45, 2, 45, 8]]);
});

test('links prefer exact selection and validate the enclosing target range', () => {
    const state = simple(), targetRange = range(0, 0, 6, 1);
    const link = { targetUri: uri, targetRange, targetSelectionRange: range(0, 6, 11) };
    assert.deepEqual(values(navigate([link], state)), [['file:///project/index.literate', 1, 6, 1, 11]]);
    assert.deepEqual(navigate([{ ...link, targetRange: range(0, 0, 999) }], state), []);
    assert.deepEqual(navigate([{ ...link, targetRange: range(0, 0, 2) }], state), []);
    assert.deepEqual(navigate([{ ...link, targetSelectionRange: null }], state), []);
    assert.deepEqual(values(navigate([{ targetUri: uri, targetRange }], state)),
        [['file:///project/index.literate', 1, 0, 2, 6]]);
});

test('reject dangerous and malformed URIs without reading any files', () => {
    const state = simple();
    for (const value of ['https://example.com/a', 'untitled:a', 'vscode-remote:///a', '/project/main.ts',
        'file://host/a', 'file://localhost/a', 'file:////host/a', 'file:///a?x', 'file:///a#x', 'file:///a?', 'file:///a#',
        'file:///a%00', 'file:///a%0a', 'file:///a%5cb', 'file:///a\\b', 'file:///bad%zz', 'file:///%2fhost/a']) {
        assert.deepEqual(navigate({ uri: value, range: range(0, 0, 1) }, state), [], value);
        assert.deepEqual(diagnose(value, range(0, 0, 1), state), [], value);
    }
    assert.equal(navigate({ uri: 'file:///project/dir/../main.ts', range: range(0, 6, 11) }, state)[0].uri.toString(),
        'file:///project/index.literate');
    assert.equal(navigate({ uri: 'file:///libs/a%20b.ts', range: range(0, 0, 1) }, state).length, 1);
});

test('validate unknown ranges, finite integer bounds, line lengths and captured sources', () => {
    const state = simple();
    for (const invalid of [undefined, null, [], {}, { start: {}, end: {} }, range(1, 4, 2),
        range(-1, 0, 1), range(0, 0.5, 1), range(0, 0, Infinity), range(NaN, 0, 1),
        range(0, 0, Number.MAX_SAFE_INTEGER + 1), range(100, 0, 1), range(0, 0, 17)]) {
        assert.deepEqual(navigate({ uri, range: invalid }, state), []);
        assert.deepEqual(diagnose(uri, invalid, state), []);
    }
    assert.deepEqual(navigate(null, state), []);
    assert.deepEqual(navigate({ uri: 'file:///project/index.literate', range: range(99, 0, 1) }, state), []);
    assert.equal(navigate({ uri: 'file:///lib.ts', range: range(Number.MAX_SAFE_INTEGER, 0, 1) }, state).length, 1);
});

test('UTF16 multiline literal sequences preserve LF, CRLF and CR source coordinates', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
        const state = context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', '😀first\nsecond').replace(/\n/g, eol) }]);
        assert.deepEqual(values(navigate({ uri, range: range(0, 2, 3, 1) }, state)),
            [['file:///project/index.literate', 1, 2, 2, 3]]);
        assert.deepEqual(values(diagnose(uri, range(0, 2, 3, 1), state)),
            [['file:///project/index.literate', 1, 2, 2, 3]]);
        assert.deepEqual(values(navigate({ uri, range: range(0, 7, 7) }, state)),
            [['file:///project/index.literate', 1, 7, 1, 7]]);
    }
});

test('fragment seams and tags select the initial literal; diagnostics split bounded intersections', () => {
    const state = context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', 'before <<child>> after') },
        { path: 'other.literate', text: fence('ts: <<child>>=', 'child') }]);
    assert.equal(state.files[0].content, 'before child after\n');
    const whole = range(0, 0, 18);
    assert.deepEqual(values(navigate({ uri, range: whole }, state)), [['file:///project/index.literate', 1, 0, 1, 7]]);
    assert.deepEqual(values(diagnose(uri, whole, state)), [['file:///project/index.literate', 1, 0, 1, 7],
        ['file:///project/other.literate', 1, 0, 1, 5], ['file:///project/index.literate', 1, 16, 1, 22]]);
    assert.deepEqual(values(navigate([{ targetUri: uri, targetRange: whole, targetSelectionRange: range(0, 7, 12) }], state)),
        [['file:///project/other.literate', 1, 0, 1, 5]]);
});

test('template wrappers never fall back, repeated slots dedup, distinct equal-text occurrences survive', () => {
    const state = context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $ template=wrap', 'same\nsame') }],
        { wrap: 'wrapper\n[CODE]separator\n[CODE]tail' });
    assert.equal(state.files[0].content, 'wrapper\nsame\nsame\nseparator\nsame\nsame\ntail');
    assert.deepEqual(navigate({ uri, range: range(0, 0, 7) }, state), []);
    assert.deepEqual(diagnose(uri, range(0, 0, 7), state), []);
    assert.deepEqual(navigate({ uri, range: range(0, 3, 3) }, state), []);
    assert.deepEqual(values(navigate([1, 2, 4, 5].map(line => ({ uri, range: range(line, 0, 4) })), state)),
        [['file:///project/index.literate', 1, 0, 1, 4], ['file:///project/index.literate', 2, 0, 2, 4]]);
    assert.deepEqual(values(diagnose(uri, range(0, 0, 4, 6), state)), [['file:///project/index.literate', 1, 0, 3, 0]]);
    assert.deepEqual(values(navigate({ uri, range: range(0, 0, 4, 6) }, state)), [['file:///project/index.literate', 1, 0, 3, 0]]);
});

test('same-source fragment seams never enclose intervening prose or definition tags', () => {
    const state = context([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', '<<first>>\n<<second>>')
        + '\nNot code.\n' + fence('ts: <<first>>=', 'first') + '\nMore prose.\n' + fence('ts: <<second>>=', 'second') }]);
    const whole = range(0, 0, 6, 1);
    const intersections = diagnose(uri, whole, state);
    assert.ok(intersections.length >= 2);
    const sourceText = state.documents[0].text.split('\n');
    for (const hit of intersections) {
        const selected = sourceText.slice(hit.range.start.line, hit.range.end.line + 1).join('\n');
        assert.ok(!selected.includes('prose') && !selected.includes('Not code') && !selected.includes('```'));
    }
    assert.deepEqual(values(navigate({ uri, range: whole }, state)), values(intersections.slice(0, 1)));
});

test('missing literal source or mappings never exposes generated outputs', () => {
    const state = simple();
    state.documents = [];
    assert.deepEqual(navigate({ uri, range: range(0, 0, 5) }, state), []);
    assert.deepEqual(diagnose(uri, range(0, 0, 5), state), []);
    const unmapped = { ...state, files: state.files.map(file => ({ ...file, mappings: [] })) };
    assert.deepEqual(navigate({ uri: 'file:///project/%6dain.ts', range: range(0, 0, 5) }, unmapped), []);
});

test('immutable context identity reuses prepared source indexes across diagnostics and navigation', () => {
    const original = simple();
    let textReads = 0;
    const documents = [...original.documents, { path: 'book.literate', text: 'Prose\r\n'.repeat(10000) }]
        .map(document => Object.freeze({ path: document.path, get text() { textReads++; return document.text; } }));
    const state = Object.freeze({ ...original, documents });
    Object.freeze(documents);
    const expected = [['file:///project/index.literate', 1, 6, 1, 11]];
    for (let i = 0; i < 1000; i++) {
        assert.deepEqual(values(diagnose(uri, range(0, 6, 11), state)), expected);
    }
    assert.deepEqual(values(navigate({ uri, range: range(0, 6, 11) }, state)), expected);
    assert.equal(textReads, documents.length, 'each captured text is indexed once per context');
    assert.deepEqual(diagnose('file://host/project/main.ts', range(0, 6, 11), state), []);
    assert.deepEqual(diagnose(uri, range(0, 6, 999), state), []);
    assert.deepEqual(diagnose(uri, range(0, 6, Infinity), state), []);
    assert.equal(textReads, documents.length, 'validation must not rebuild cached indexes');
    assert.deepEqual(values(diagnose(uri, range(0, 6, 11), { ...state })), expected);
    assert.equal(textReads, documents.length * 2, 'a new context identity prepares independently');
});

test('replacement snapshots at the same root use their own text bounds and source offsets', () => {
    const previous = simple();
    assert.equal(diagnose(uri, range(0, 6, 11), previous).length, 1);
    const next = context([{ path: 'index.literate', text: '\n\n' + fence('ts: <<main.*>>= main.ts $', 'x') }]);
    assert.deepEqual(diagnose(uri, range(0, 6, 11), next), []);
    assert.deepEqual(values(diagnose(uri, range(0, 0, 1), next)), [['file:///project/index.literate', 3, 0, 3, 1]]);
    assert.deepEqual(values(diagnose(uri, range(0, 6, 11), previous)), [['file:///project/index.literate', 1, 6, 1, 11]]);
    const remote = { ...previous, root: Uri.parse('https://example.com/project') as unknown as vscode.Uri };
    assert.deepEqual(diagnose(uri, range(0, 6, 11), remote), []);
    assert.deepEqual(navigate({ uri, range: range(0, 6, 11) }, remote), []);
});

test('reply traversal and diagnostic splitting have fixed caps', () => {
    const state = simple();
    const reply = Array.from({ length: 1001 }, (_, line) => ({ uri: 'file:///lib.ts', range: range(line, 0, 1) }));
    assert.equal(navigate(reply, state).length, 1000);
    const hostile = new Array(1001).fill(null);
    Object.defineProperty(hostile, 1000, { get() { throw new Error('must not traverse past reply cap'); } });
    assert.deepEqual(navigate(hostile, state), []);
    const documents = [{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $',
        Array.from({ length: 110 }, (_, i) => '<<piece' + i + '>>').join('\n')) },
        ...Array.from({ length: 110 }, (_, i) => ({ path: 'part' + i + '.literate', text: fence('ts: <<piece' + i + '>>=', 'x') }))];
    const many = context(documents);
    const locations = diagnose(uri, range(0, 0, 1, 109), many);
    assert.equal(locations.length, 100);
    assert.equal(new Set(locations.map(location => JSON.stringify(values([location])))).size, 100);
});
