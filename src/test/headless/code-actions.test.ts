import assert = require('node:assert/strict');
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { generateProject } from '../../engine';
import { fixture, fence, root, Range } from './vscode-fixture';

type Fixture = ReturnType<typeof fixture>;
const token = (isCancellationRequested = false) => ({
    isCancellationRequested, onCancellationRequested: () => ({ dispose() {} })
} as vscode.CancellationToken);
const diagnostics = (f: Fixture, doc: vscode.TextDocument) =>
    f.diagnostics.get(doc.uri.toString())! as vscode.Diagnostic[];
async function actions(f: Fixture, doc: vscode.TextDocument, values: readonly vscode.Diagnostic[],
    cancellation = token(), only?: vscode.CodeActionKind) {
    const result = await new f.extension.LiterateCodeActionProvider(f.repository).provideCodeActions(
        doc, new Range(0, 0, doc.lineCount - 1, 0) as vscode.Range,
        { diagnostics: values, only, triggerKind: 1 }, cancellation);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.directories, []);
    return result;
}
function apply(doc: vscode.TextDocument, edit: vscode.WorkspaceEdit): string {
    let text = doc.getText();
    for (const replacement of [...edit.get(doc.uri)].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) {
        text = text.slice(0, doc.offsetAt(replacement.range.start)) + replacement.newText
            + text.slice(doc.offsetAt(replacement.range.end));
    }
    return text;
}

for (const eol of ['\n', '\r\n']) {
    test(`engine diagnostic produces a document-bound quick fix and a valid definition (${JSON.stringify(eol)})`, async () => {
        const f = fixture();
        const text = root('before <<missing>> after').replace(/\n/g, eol).trimEnd();
        const doc = f.open('index.literate', text);
        const unrelated = f.open('other.literate', 'unrelated active document');
        Object.assign(f.mock.window, { activeTextEditor: { document: unrelated } });
        await f.process();
        const values = diagnostics(f, doc);
        assert.equal(values[0].code, 'missing-fragment');
        const [action] = await actions(f, doc, values);
        assert.ok(action);
        assert.equal(action.kind?.value, 'quickfix');
        assert.deepEqual(action.diagnostics, values);
        assert.equal(action.command, undefined);
        assert.ok(action.edit);
        assert.equal(action.edit.size, 1);
        assert.deepEqual(action.edit.get(unrelated.uri), []);
        const fixed = apply(doc, action.edit);
        assert.ok(fixed.startsWith(text));
        assert.ok(fixed.endsWith(`${eol}~~~ text : <<missing>>=${eol}~~~${eol}`));
        const result = generateProject([{ path: 'index.literate', text: fixed }]);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(result.files.find(file => file.path === 'generated/main.txt')?.content, 'before  after\n');
        assert.equal(doc.getText(), text, 'provider only proposes an edit');
    });
}

test('stable code, not message, selects the action; duplicates coalesce and kind filtering is respected', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<missing>> <<missing>>'));
    await f.process();
    const [value] = diagnostics(f, doc);
    const localized = { ...value, message: 'Different wording', code: { value: 'missing-fragment', target: doc.uri } };
    assert.equal((await actions(f, doc, [localized, localized])).length, 1);
    assert.deepEqual(await actions(f, doc, [{ ...value, code: undefined }]), []);
    assert.deepEqual(await actions(f, doc, [{ ...value, code: 'other' }]), []);
    assert.deepEqual(await actions(f, doc, [value], token(), f.mock.CodeActionKind.Refactor), []);
    assert.equal((await actions(f, doc, [value], token(), f.mock.CodeActionKind.QuickFix)).length, 1);
});

test('refresh uses unsaved definitions in other files to decline stale diagnostics', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<missing>>'));
    await f.process();
    const old = diagnostics(f, doc);
    f.open('chapter.literate', fence('text: <<missing>>=', 'now defined'));
    assert.deepEqual(await actions(f, doc, old), []);
});

for (const text of [root('plain text'), root('\\<<missing>>'), 'Mention <<missing>>.\n',
    fence('text', '<<missing>>'), fence('text: <<missing>>=', 'body'), root('<<missing>>').replace(/```\n$/, '')]) {
    test(`declines stale or unsafe occurrences in ${JSON.stringify(text)}`, async () => {
        const f = fixture();
        const doc = f.open('index.literate', root('<<missing>>'));
        await f.process();
        const old = diagnostics(f, doc);
        const current = f.open('index.literate', text);
        assert.deepEqual(await actions(f, current, old), []);
    });
}

test('excluded documents and out-of-range stale diagnostics return no actions', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<missing>>'));
    await f.process();
    const [value] = diagnostics(f, doc);
    assert.deepEqual(await actions(f, doc, [{ ...value, range: new Range(999, 0, 999, 1) as vscode.Range }]), []);
    const excluded = f.open('node_modules/ignored.literate', doc.getText());
    assert.deepEqual(await actions(f, excluded, [value]), []);
});

test('cancellation before and during refresh returns no actions', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<missing>>'));
    await f.process();
    const values = diagnostics(f, doc);
    const before = f.discoveries();
    assert.deepEqual(await actions(f, doc, values, token(true)), []);
    assert.equal(f.discoveries(), before);
    const cancellation = token();
    const pending = actions(f, doc, values, cancellation);
    Object.assign(cancellation, { isCancellationRequested: true });
    assert.deepEqual(await pending, []);
});

test('buffer replacement during refresh and requests on superseded documents are declined', async () => {
    const f = fixture();
    const doc = f.open('index.literate', root('<<missing>>'));
    await f.process();
    const values = diagnostics(f, doc);
    const pending = actions(f, doc, values);
    f.open('index.literate', root('<<different>>'));
    assert.deepEqual(await pending, []);
    assert.deepEqual(await actions(f, doc, values), []);
});
