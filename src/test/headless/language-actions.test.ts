/* Protocol and VS Code API spellings are intentional. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type * as vscode from 'vscode';
import { SourceDocument } from '../../engine';
import { mapGeneratedRange, projectLanguageSources } from '../../language-projection';
import type { LanguageCodeActionContext } from '../../language-actions';
import { generatedFromBook } from './authoritative-book';
import { Position, Range } from './vscode-fixture';

const root = path.resolve(__dirname, '../../..');
const chapter = fs.readFileSync(path.join(root, 'literate/language-actions.literate'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/language-actions.ts'), 'utf8');
class Uri {
    constructor(private readonly value: string) {}
    get scheme() { return this.value.split(':', 1)[0]; }
    get authority() { return this.value.startsWith('file://host/') ? 'host' : ''; }
    toString() { return this.value; }
}
class WorkspaceEdit {
    readonly values: { uri: Uri; range: Range; newText: string }[] = [];
    replace(uri: Uri, range: Range, newText: string) { this.values.push({ uri, range, newText }); }
}
class CodeActionKind {
    static readonly Empty = new CodeActionKind('');
    constructor(readonly value: string) {}
    append(value: string) { return new CodeActionKind(this.value ? this.value + '.' + value : value); }
}
class CodeAction {
    edit?: WorkspaceEdit;
    diagnostics?: Diagnostic[];
    isPreferred?: boolean;
    constructor(readonly title: string, readonly kind?: CodeActionKind) {}
}
class Diagnostic {
    source?: string;
    code?: string | number;
    tags?: number[];
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}
const mock = { Position, Range, Uri, WorkspaceEdit, CodeActionKind, CodeAction, Diagnostic,
    CodeActionTriggerKind: { Invoke: 1, Automatic: 2 }, DiagnosticSeverity: { Error: 0 }, DiagnosticTag: {} };
const exported: Partial<typeof import('../../language-actions')> = {};
new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText)((name: string) => {
    if (name === 'vscode') { return mock; }
    assert.equal(name, './language-projection');
    return { mapGeneratedRange };
}, exported);
const convert = exported.mapLanguageCodeActions!;
const point = (line: number, character: number) => ({ line, character });
const span = (line: number, start: number, end: number, endLine = line) =>
    ({ start: point(line, start), end: point(endLine, end) });
const fence = (header: string, body: string) => '```' + header + '\n' + body + '\n```\n';

function setup(documents?: SourceDocument[]): { context: LanguageCodeActionContext; uri: string } {
    const inputs = documents || [{ path: 'index.literate',
        text: fence('ts: <<main.*>>= main.ts $', 'const value = 1;\nvalue;') }];
    const projection = projectLanguageSources(inputs);
    assert.deepEqual(projection.diagnostics, []);
    const file = projection.files[0], mapping = file.mappings[0];
    const text = inputs.find(document => document.path === mapping.sourcePath)!.text;
    const document = {
        uri: new Uri('file:///project/' + mapping.sourcePath), version: 7, isClosed: false,
        getText: () => text,
        positionAt(offset: number) {
            const before = text.slice(0, offset).split(/\r\n|\r|\n/);
            return new Position(before.length - 1, before[before.length - 1].length);
        }
    } as unknown as vscode.TextDocument;
    const generatedUri = new Uri('file:///project/main.ts');
    return { uri: generatedUri.toString(), context: { document, sourcePath: mapping.sourcePath,
        generatedUri: generatedUri as unknown as vscode.Uri, file, mapping, requestVersion: 7,
        triggerKind: 1 } };
}
const edit = (range: unknown, newText = 'changed') => ({ range, newText });
const action = (uri: string, values: unknown[], extra: Record<string, unknown> = {}) =>
    ({ title: 'Safe fix', kind: 'quickfix', edit: { changes: { [uri]: values } }, ...extra });

function values(result: vscode.CodeAction[]) {
    return result.map(value => ({ title: value.title, kind: value.kind?.value,
        edits: (value.edit as unknown as WorkspaceEdit).values.map(item => [item.range.start.line,
            item.range.start.character, item.range.end.line, item.range.end.character, item.newText]) }));
}

test('owned chapter assembles exactly with bounded design fragments', () => {
    const generated = generatedFromBook('src/language-actions.ts');
    assert.equal(generated.content, source);
    for (const match of chapter.matchAll(/```ts[^\n]*\n([\s\S]*?)\n```/g)) {
        assert.ok(match[1].split('\n').length <= 30);
    }
});

test('maps a complete plain edit set to the current source occurrence', () => {
    const { context, uri } = setup();
    const result = convert([action(uri, [edit(span(0, 6, 11), 'item'), edit(span(0, 14, 15), '2')])], context);
    assert.deepEqual(values(result), [{ title: 'Safe fix', kind: 'quickfix', edits: [
        [1, 6, 1, 11, 'item'], [1, 14, 1, 15, '2']
    ] }]);
    assert.equal(result[0].command, undefined);
    assert.equal(result[0].diagnostics, undefined);
});

test('requires explicit invocation and an exact open source snapshot', () => {
    const { context, uri } = setup(), reply = [action(uri, [edit(span(0, 0, 5))])];
    assert.equal(convert(reply, { ...context, triggerKind: 2 }).length, 0);
    assert.equal(convert(reply, { ...context, requestVersion: 6 }).length, 0);
    assert.equal(convert(reply, { ...context, requestVersion: -1 }).length, 0);
    const closed = { ...context.document, isClosed: true } as vscode.TextDocument;
    assert.equal(convert(reply, { ...context, document: closed }).length, 0);
    const changed = { ...context.document, getText: () => context.document.getText().replace('value', 'other') } as vscode.TextDocument;
    assert.equal(convert(reply, { ...context, document: changed }).length, 0);
});

test('rejects the whole response for commands, disabled or malformed actions', () => {
    const { context, uri } = setup(), good = action(uri, [edit(span(0, 0, 5))]);
    for (const bad of [{ title: 'Run', command: 'evil' }, { ...good, command: {} },
        { ...good, disabled: { reason: 'no' } }, { ...good, title: '' }]) {
        assert.deepEqual(convert([good, bad], context), []);
    }
});

test('bounds action kinds and preserves only a boolean preference hint', () => {
    const { context, uri } = setup(), base = action(uri, [edit(span(0, 0, 5))]);
    const [preferred] = convert([{ ...base, kind: 'refactor.extract', isPreferred: true }], context);
    assert.equal(preferred.kind?.value, 'refactor.extract');
    assert.equal(preferred.isPreferred, true);
    for (const bad of [{ ...base, kind: 'source.fixAll' }, { ...base, kind: 'quickfix..unsafe' },
        { ...base, isPreferred: 1 }]) { assert.deepEqual(convert([bad], context), []); }
});

test('rejects every unsupported workspace edit form and URI', () => {
    const { context, uri } = setup(), base = { title: 'No' };
    const edits = [
        { documentChanges: [] }, { changes: { [uri]: [edit(span(0, 0, 1))] }, changeAnnotations: {} },
        { changes: { [uri]: [edit(span(0, 0, 1))], 'file:///project/other.ts': [] } },
        { changes: { 'file:///project/other.ts': [edit(span(0, 0, 1))] } },
        { changes: { [uri]: [] } }, { changes: { [uri]: [{ ...edit(span(0, 0, 1)), annotationId: 'x' }] } },
        { changes: { [uri]: [{ ...edit(span(0, 0, 1)), insertTextFormat: 2 }] } }
    ];
    assert.deepEqual(convert(edits.map(value => ({ ...base, edit: value })), context), []);
});

test('rejects the whole action for unmapped, cross-occurrence or overlapping edits', () => {
    const documents = [{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', '<<piece>>\n<<piece>>')
        + fence('ts: <<piece>>=', 'same') }];
    const { context, uri } = setup(documents);
    assert.deepEqual(convert([action(uri, [edit(span(0, 0, 4)), edit(span(1, 0, 4))])], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 0, 3)), edit(span(0, 2, 4))])], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 1, 1), 'a'), edit(span(0, 1, 1), 'b')])], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 0, 0), 'a'), edit(span(0, 0, 2), 'b')])], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 4, 4), 'seam')])], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 0, 4)), edit(span(99, 0, 1))])], context), []);
});

test('preserves only a wholly safe bounded diagnostic set', () => {
    const { context, uri } = setup();
    const diagnostic = { range: span(0, 6, 11), message: 'rename', severity: 2, code: 'W1', source: 'server', tags: [1] };
    const [result] = convert([action(uri, [edit(span(0, 6, 11))], { diagnostics: [diagnostic] })], context);
    assert.equal(result.diagnostics?.length, 1);
    assert.deepEqual([result.diagnostics![0].range.start.line, result.diagnostics![0].range.start.character,
        result.diagnostics![0].severity, result.diagnostics![0].code], [1, 6, 1, 'W1']);
    const unsafe = { ...diagnostic, relatedInformation: [{ location: 'file:///elsewhere' }] };
    const [without] = convert([action(uri, [edit(span(0, 6, 11))], { diagnostics: [diagnostic, unsafe] })], context);
    assert.equal(without.diagnostics, undefined);
    for (const malformed of [{ ...diagnostic, source: 1 }, { ...diagnostic, code: {} }, { ...diagnostic, code: NaN }]) {
        const [clean] = convert([action(uri, [edit(span(0, 6, 11))], { diagnostics: [malformed] })], context);
        assert.equal(clean.diagnostics, undefined);
    }
});

test('rejects oversized replies and never truncates edit sets', () => {
    const { context, uri } = setup();
    assert.deepEqual(convert(new Array(1001).fill(action(uri, [edit(span(0, 0, 1))])), context), []);
    assert.deepEqual(convert([action(uri, new Array(1001).fill(edit(span(0, 0, 1))))], context), []);
    assert.deepEqual(convert([action(uri, [edit(span(0, 0, 1), 'a'.repeat(600000)),
        edit(span(0, 2, 3), 'b'.repeat(600000))])], context), []);
    assert.deepEqual(convert({ title: 'Command shape', command: 'x' }, context), []);
});
