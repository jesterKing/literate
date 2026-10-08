/* Public VS Code/LSP API spellings are intentional in the isolated module mock. */
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-explicit-any */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { EventEmitter } from 'node:events';
import { parseProject, parseFragmentHeader, scanFragmentTags } from '../../engine';
import * as projection from '../../language-projection';
import { generatedFromBook } from './authoritative-book';

const root = path.resolve(__dirname, '../../..');
const chapter = fs.readFileSync(path.join(root, 'literate/language-features.literate'), 'utf8');
const chunks = [...chapter.matchAll(/```ts : <<language feature [^>]+>>=\n([\s\S]*?)\n```/g)].map(match => match[1]);
const source = chunks.join('\n') + '\n';
const fence = (body: string, header = 'ts: <<main.*>>= main.ts $') => '```' + header + '\n' + body + '\n```\n';
class Position {
    constructor(public line: number, public character: number) {}
    isEqual(other: Position) { return this.line === other.line && this.character === other.character; }
}
class Range {
    constructor(public start: Position, public end: Position) {}
    contains(other: Position | Range): boolean {
        if (other instanceof Range) { return this.contains(other.start) && this.contains(other.end); }
        const before = (a: Position, b: Position) => a.line < b.line || a.line === b.line && a.character <= b.character;
        return before(this.start, other) && before(other, this.end);
    }
}
const uri = (fsPath: string) => ({ fsPath, scheme: 'file', authority: '', toString: () => 'file://' + fsPath });
function fixture(body = 'console.lo') {
    const events = new EventEmitter(), subscriptions: any[] = [], clients: any[] = [];
    const event = (name: string) => (fn: (...args: any[]) => void) => {
        events.on(name, fn); return { dispose: () => events.off(name, fn) };
    };
    const folder = { uri: uri('/project'), name: 'project', index: 0 };
    const f: any = { languageDiagnostics: false, text: fence(body), config: { typescript: { command: '/bin/server', args: [] } }, clients,
        reply: [{ label: 'log', kind: 3 }], snapshots: 0, events, subscriptions, logs: [], commands: new Map(), contexts: [],
        capabilities: { hoverProvider: true, completionProvider: {}, codeActionProvider: true }, actions: [{ title: 'mapped action' }] };
    const document: any = { uri: uri('/project/index.literate'), languageId: 'markdown', version: 1, isClosed: false,
        getText: () => f.text,
        offsetAt: (p: Position) => f.text.split('\n').slice(0, p.line).reduce((n: number, line: string) => n + line.length + 1, 0) + p.character,
        positionAt: (at: number) => { const lines = f.text.slice(0, at).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
        getWordRangeAtPosition: (p: Position, expression: RegExp) => {
            for (const match of f.text.split('\n')[p.line].matchAll(new RegExp(expression.source, 'gu'))) {
                if (p.character >= match.index! && p.character <= match.index! + match[0].length) {
                    return new Range(new Position(p.line, match.index!), new Position(p.line, match.index! + match[0].length));
                }
            }
            return undefined;
        } };
    const workspace: any = { textDocuments: [document], isTrusted: true, workspaceFolders: [folder], getWorkspaceFolder: () => workspace.workspaceFolders[0],
        getConfiguration: () => ({ inspect: (key: string) => {
            assert.equal(key, 'languageServers'); return { globalValue: f.config, workspaceValue: f.workspaceConfig };
        }, get(key: string, fallback: boolean) {
            assert.ok(['automaticCompletion', 'languageDiagnostics'].includes(key)); return f[key] ?? fallback;
        } }),
        onDidGrantWorkspaceTrust: event('trust'), onDidChangeConfiguration: event('config'), onDidChangeWorkspaceFolders: event('folders'),
        onDidChangeTextDocument: event('change'), onDidOpenTextDocument: event('open'), onDidCloseTextDocument: event('close'),
        createFileSystemWatcher: (pattern: string) => {
            assert.equal(pattern, '**/*');
            return { dispose() {}, onDidChange: event('disk'), onDidCreate: event('create'), onDidDelete: event('delete') };
        } };
    const token: any = { isCancellationRequested: false, onCancellationRequested: event('cancel') };
    const vscode: any = { workspace, env: {}, Uri: { file: uri }, Position, Range,
        CompletionTriggerKind: { Invoke: 0, TriggerForIncompleteCompletions: 2 }, CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
            dispose() {}
        },
        TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2 },
        window: { state: { focused: true }, onDidChangeActiveTextEditor: event('editor'),
            onDidChangeWindowState: event('focus'), onDidChangeTextEditorSelection: event('selection'),
            createOutputChannel: (name: string) => {
            assert.equal(name, 'Literate Language Servers');
            return { appendLine: (line: string) => f.logs.push(line), clear: () => { f.logs = []; f.clears = (f.clears || 0) + 1; },
                dispose: () => { f.channelDisposed = true; } };
        } },
        commands: { executeCommand: async (name: string, key?: string, value?: boolean) => {
            if (name === 'setContext') {
                assert.equal(key, 'literate.automaticCompletionPending'); f.contexts.push(value); f.pendingContext = value;
                await f.onContext?.(value); return;
            }
            if (name === 'editor.action.triggerParameterHints') {
                f.hints = (f.hints || 0) + 1; f.signature = await f.signatureProvider.provideSignatureHelp(document, f.cursor, token, { triggerKind: 0 }); return;
            }
            assert.equal(name, 'editor.action.triggerSuggest'); assert.equal(f.pendingContext, false);
            f.suggestions = (f.suggestions || 0) + 1;
            await f.onSuggest?.(); f.items = await f.complete();
        }, registerCommand: (name: string, callback: () => void) => {
            f.commands.set(name, callback); return { dispose: () => f.commands.delete(name) };
        } },
        CompletionItemKind: { Text: 0, Method: 1, Function: 2, Folder: 18 },
        CompletionItem: class { constructor(public label: string) {} },
        CompletionList: class { constructor(public items: any[], public isIncomplete: boolean) {} },
        SnippetString: class { constructor(public value: string) {} },
        SignatureHelp: class { signatures: any[] = []; },
        SignatureInformation: class { parameters: any[] = []; constructor(public label: any, public documentation: any) {} },
        ParameterInformation: class { constructor(public label: any, public documentation: any) {} },
        MarkdownString: class { value = ''; appendMarkdown(s: string) { this.value += s; } appendText(s: string) { this.value += s; }
            appendCodeblock(s: string, lang: string) { this.value += lang + '\n' + s; } },
        Hover: class { constructor(public contents: any, public range: any) {} },
        languages: {
            registerSignatureHelpProvider(_s: any, provider: any, ...triggers: any[]) {
                f.signatureProvider = provider; f.signatureTriggers = triggers; return { dispose() {} };
            },
            registerDefinitionProvider(_s: any, p: any) { f.definitionProvider = p; return { dispose() {} }; },
            registerTypeDefinitionProvider(_s: any, p: any) { f.typeDefinitionProvider = p; return { dispose() {} }; },
            registerImplementationProvider(_s: any, p: any) { f.implementationProvider = p; return { dispose() {} }; },
            registerReferenceProvider(_s: any, p: any) { f.referencesProvider = p; return { dispose() {} }; },
            registerCodeActionsProvider(selector: any, p: any) { f.codeActionSelector = selector; f.codeActionProvider = p; return { dispose() {} }; },
            registerHoverProvider(selector: any, provider: any) {
                f.hoverSelector = selector; f.hoverProvider = provider; return { dispose() {} };
            },
            registerCompletionItemProvider(selector: any, provider: any, ...triggers: any[]) {
                f.completionSelector = selector;
                assert.deepEqual(triggers, []); f.completionProvider = provider; return { dispose() {} };
            }
        } };
    class Client {
        disposed = 0; syncs: any[] = []; requests: any[] = [];
        capabilities = f.capabilities;
        constructor(public options: any) { clients.push(this); }
        supportsCodeActions() { f.supportChecks = (f.supportChecks || 0) + 1;
            return this.capabilities.codeActionProvider === true
            || this.capabilities.codeActionProvider !== null && typeof this.capabilities.codeActionProvider === 'object'
                && !Array.isArray(this.capabilities.codeActionProvider); }
        onDidStop(callback: () => void) { f.stopClient = callback; return () => { f.stopUnsubscribed = true; }; }
        async initialize() { await f.onInitialize?.(); }
        async sync(docs: any) { this.syncs.push(docs); await f.onSync?.(); }
        async request(method: string, params: any, signal: AbortSignal) {
            this.requests.push({ method, params, signal }); await f.onRequest?.(signal); return f.reply;
        }
        async dispose() { this.disposed++; if (f.disposeFailure) { throw new Error('secret'); } }
    }
    const exports: any = {};
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } });
    new Function('require', 'exports', compiled.outputText)((name: string) => {
        if (name === 'vscode') { return vscode; }
        if (name === './language-actions') { return { mapLanguageCodeActions: (reply: any, ctx: any) => {
            f.actionReply = reply; f.actionContext = ctx; return f.actions;
        } }; }
        if (name === './language-navigation') { return { mapLanguageLocations: (reply: any, ctx: any) => {
            f.navigationContext = ctx; return reply;
        } }; }
        if (name === './language-diagnostics') { return { LanguageDiagnostics: class {
            constructor(context: any) { context.subscriptions.push(this); }
            invalidate(key?: string) {
                f.invalidations = (f.invalidations || 0) + 1;
                (f.invalidatedKeys ??= []).push(key);
                if (key === undefined || key === f.diagnosticSync?.key) { f.visibleDiagnostics = false; }
            }
            dispose() {}
            async synchronize(key: string, client: any, ctx: any, docs: any, fresh: any) {
                f.diagnosticSync = { key, ctx, fresh }; await client.sync(docs); f.visibleDiagnostics = fresh();
            }
        } }; }
        if (name === './language-client') { return { LanguageClient: Client }; }
        if (name === './language-projection') { return projection; }
        if (name === './engine') { return { parseProject, parseFragmentHeader, scanFragmentTags }; }
        throwIfUnexpected(name); return require(name);
    }, exports);
    exports.registerLanguageFeatures({ subscriptions }, async (value: any) => {
        assert.equal(value, folder); f.snapshots++; await f.onSnapshot?.();
        return { documents: f.documents ?? [{ path: 'index.literate', text: f.text }], templates: f.templates ?? {} };
    });
    Object.assign(f, { vscode, workspace, document, token, folder, cursor: new Position(1, body.length),
        complete: (kind = 0) => f.completionProvider.provideCompletionItems(document, f.cursor, token, { triggerKind: kind }),
        hover: () => f.hoverProvider.provideHover(document, f.cursor, token),
        codeActions: (range = new Range(new Position(1, 0), f.cursor), context: any = {
            diagnostics: [], triggerKind: 1
        }) => f.codeActionProvider.provideCodeActions(document, range, context, token),
        restart: () => f.commands.get('literate.restartLanguageServers')(),
        dispose: () => subscriptions.forEach(item => item.dispose()) });
    f.editor = { document, selections: [], selection: undefined };
    f.select = (cursor = f.cursor, kind = 1) => {
        f.cursor = cursor; f.editor.selection = { active: cursor, isEmpty: true };
        f.editor.selections = [f.editor.selection];
        events.emit('selection', { textEditor: f.editor, kind });
    };
    f.select(); vscode.window.activeTextEditor = f.editor;
    f.type = (text: string, reason?: number) => {
        const start = f.cursor, at = document.offsetAt(start);
        f.text = f.text.slice(0, at) + text + f.text.slice(at); document.version++;
        events.emit('change', { document, reason, contentChanges: [
            { range: new Range(start, start), rangeOffset: at, rangeLength: 0, text }
        ] });
        f.select(document.positionAt(at + text.length));
    };
    return f;
}
test('snippet completion and resolve preserve edits and copy only untrusted metadata', async () => {
    const f = fixture(); f.capabilities.completionProvider.resolveProvider = true;
    f.reply = [{ label: 'log', kind: 15, insertTextFormat: 2, insertText: 'log(${1:value})$0', data: { id: 7 } }];
    const [item] = await f.complete(), original = item.insertText, range = item.range;
    assert.equal(original.value, 'log(${1:value})$0');
    f.reply = { label: 'evil', detail: 'resolved', documentation: { kind: 'markdown', value: '[bad](command:evil)' },
        textEdit: { range: lspRange(0, 10), newText: 'evil' }, command: { command: 'evil' }, additionalTextEdits: [{}] };
    assert.equal(await f.completionProvider.resolveCompletionItem(item, f.token), item);
    assert.equal(item.detail, 'resolved'); assert.equal(item.documentation.isTrusted, false);
    assert.equal(item.insertText, original); assert.equal(item.range, range); assert.equal(item.command, undefined);
    assert.equal(item.additionalTextEdits, undefined); assert.equal(item.label, 'log');
    assert.deepEqual(f.clients[0].requests[1].params.data, { id: 7 }); f.dispose();
});

test('resolve requires capability and current input, view, configuration and cancellation', async () => {
    for (const mutate of [
        (f: any) => { f.capabilities.completionProvider.resolveProvider = false; },
        (f: any) => { f.document.version++; }, (f: any) => { f.select(new Position(1, 1)); },
        (f: any) => { f.config.typescript.args.push('changed'); },
        (f: any) => { f.token.isCancellationRequested = true; }, (f: any) => { f.restart(); }
    ]) {
        const f = fixture(); f.capabilities.completionProvider.resolveProvider = true;
        const [item] = await f.complete(); mutate(f); f.reply = { detail: 'stale' };
        await f.completionProvider.resolveCompletionItem(item, f.token);
        assert.equal(item.detail, undefined); assert.equal(f.clients[0].requests.length, 1); f.dispose();
    }
    const f = fixture(); f.capabilities.completionProvider.resolveProvider = true;
    const [item] = await f.complete(); f.reply = { detail: 'late' }; f.onRequest = () => { f.document.version++; };
    await f.completionProvider.resolveCompletionItem(item, f.token); assert.equal(item.detail, undefined); f.dispose();
});

test('Mason CSS rgb snippet survives list editRange defaults with explicit item edits', async () => {
    const f = fixture(); f.text = fence('a {\n    color: rg\n}', 'css: <<main.*>>= main.css $');
    f.config = { css: { command: '/bin/server' } }; f.cursor = new Position(2, 13);
    // Shape captured from language-groups-host-46Amon/server-traces.json, CSS response id 9.
    const range = lspRange(11, 13, 1), snippet = 'rgb(${1:red}, ${2:green}, ${3:blue})';
    f.reply = { isIncomplete: false, itemDefaults: { editRange: range }, items: [
        { label: 'rgb', detail: 'rgb($red, $green, $blue)', textEdit: { range, newText: snippet }, insertTextFormat: 2, kind: 3 },
        { label: 'unsafe', command: { command: 'editor.action.triggerSuggest' } }
    ] };
    const result = await f.complete(); assert.equal(result.items.length, 1);
    assert.equal(result.items[0].insertText.value, snippet);
    assert.deepEqual(result.items[0].range, new Range(new Position(2, 11), new Position(2, 13))); f.dispose();
});

test('completion defaults inherit safe ranges, snippets and data without overriding item fields', async () => {
    const f = fixture(); f.capabilities.completionProvider.resolveProvider = true;
    f.reply = { isIncomplete: true, itemDefaults: {
        editRange: lspRange(8, 10), insertTextFormat: 2, insertTextMode: 1, data: { inherited: true }
    }, items: [
        { label: 'snippet', textEditText: 'log(${1:value})', insertText: 'ignored' },
        { label: 'plain', insertTextFormat: 1, insertText: 'plain text', data: { own: true } },
        { label: 'label fallback' },
        { label: 'explicit', textEdit: { range: lspRange(9, 10), newText: 'own edit' } },
        { label: 'extra', additionalTextEdits: [{}] }, { label: 'command', command: {} },
        { label: 'invalid mode', insertTextMode: 2 }, { label: 'invalid text', textEditText: 3 }
    ] };
    const result = await f.complete(), items = result.items;
    assert.equal(result.isIncomplete, true); assert.equal(items.length, 4);
    assert.equal(items[0].insertText.value, 'log(${1:value})'); assert.equal(items[0].range.start.character, 8);
    assert.equal(items[1].insertText, 'plain text'); assert.equal(items[2].insertText.value, 'label fallback');
    assert.equal(items[3].insertText.value, 'own edit'); assert.equal(items[3].range.start.character, 9);
    f.reply = { detail: 'resolved', command: {}, additionalTextEdits: [{}], insertText: 'evil' };
    for (const item of items.slice(0, 2)) { await f.completionProvider.resolveCompletionItem(item, f.token); }
    assert.deepEqual(f.clients[0].requests[1].params.data, { inherited: true });
    assert.deepEqual(f.clients[0].requests[2].params.data, { own: true });
    assert.equal(items[0].insertText.value, 'log(${1:value})'); assert.equal(items[0].command, undefined);
    assert.equal(items[0].additionalTextEdits, undefined); f.dispose();
});

test('default insert/replace ranges preserve containment and item overrides', async () => {
    const f = fixture('console.log'); f.cursor = new Position(1, 10);
    f.reply = { itemDefaults: { editRange: { insert: lspRange(8, 10), replace: lspRange(8, 11) } },
        items: [{ label: 'log', textEditText: 'log()' }] };
    const [item] = (await f.complete()).items;
    assert.equal(item.insertText, 'log()'); assert.equal(item.range.inserting.end.character, 10);
    assert.equal(item.range.replacing.end.character, 11); f.dispose();
});

test('meaningful unsupported, malformed and unsafe completion defaults fail closed', async () => {
    for (const defaults of [null, [], 'invalid', { command: {} }, { additionalTextEdits: [] },
        { commitCharacters: [';'] }, { unknown: true }, { insertTextFormat: 3 }, { insertTextMode: 2 },
        { editRange: null }, { editRange: lspRange(0, 999) }, { editRange: lspRange(0, 2) },
        { editRange: { insert: lspRange(8, 10), replace: lspRange(9, 10) } },
        { editRange: { ...lspRange(8, 10), insert: lspRange(8, 10) } }
    ]) {
        const f = fixture(); f.reply = { itemDefaults: defaults, items: [{ label: 'log' }] };
        assert.equal(await f.complete(), undefined, JSON.stringify(defaults)); f.dispose();
    }
    const f = fixture(); f.text = fence('<<piece>>\n<<piece>>') + fence('obj.lo', ': <<piece>>=');
    f.cursor = new Position(5, 6);
    f.reply = { itemDefaults: { editRange: lspRange(4, 6, 1) }, items: [{ label: 'log' }] };
    assert.equal(await f.complete(), undefined, 'a different expansion occurrence is not the active mapping'); f.dispose();
});

test('incomplete completion retriggers use LSP kind 3', async () => {
    const f = fixture(); f.reply = { isIncomplete: true, items: [{ label: 'log' }] };
    assert.equal((await f.complete()).isIncomplete, true);
    await f.complete(2); assert.deepEqual(f.clients[0].requests[1].params.context, { triggerKind: 3 }); f.dispose();
});

test('explicit code actions map request range and sanitize context without resolve or commands', async () => {
    const f = fixture();
    const diagnostic = { range: new Range(new Position(1, 8), new Position(1, 10)), message: 'problem', severity: 1,
        code: { value: 'code', target: uri('/ignore') }, source: 'server', tags: [1], relatedInformation: [{}] };
    const result = await f.codeActions(undefined, { diagnostics: [diagnostic], only: { value: 'quickfix' }, triggerKind: 1 });
    assert.deepEqual(result, f.actions); assert.equal(f.clients[0].requests[0].method, 'textDocument/codeAction');
    assert.deepEqual(Object.keys(f.clients[0].requests[0].params).sort(), ['context', 'range', 'textDocument']);
    assert.deepEqual(f.clients[0].requests[0].params.range, lspRange(0, 10));
    assert.deepEqual(f.clients[0].requests[0].params.context, { diagnostics: [{ range: lspRange(8, 10), message: 'problem',
        severity: 2, code: 'code', source: 'server', tags: [1] }], only: ['quickfix'], triggerKind: 1 });
    assert.equal(f.actionContext.requestVersion, f.document.version); assert.equal(f.actionContext.triggerKind, 1);
    assert.equal(f.supportChecks, 1);
    assert.equal('resolveCodeAction' in f.codeActionProvider, false); assert.equal(f.actionReply, f.reply); f.dispose();
});

test('code actions require explicit invocation, capability, mapped range, freshness and cancellation', async () => {
    for (const mutate of [
        (f: any) => { f.capabilities.codeActionProvider = false; },
        (f: any) => { f.token.isCancellationRequested = true; }
    ]) {
        const f = fixture(); mutate(f); assert.equal(await f.codeActions(), undefined);
        assert.equal(f.clients[0]?.requests.length ?? 0, 0); f.dispose();
    }
    const automatic = fixture(); assert.equal(await automatic.codeActions(undefined, { diagnostics: [], triggerKind: 2 }), undefined);
    assert.equal(automatic.snapshots, 0); automatic.dispose();
    const outside = fixture(); assert.equal(await outside.codeActions(new Range(new Position(0, 0), new Position(1, 2))), undefined);
    assert.equal(outside.clients[0]?.requests.length ?? 0, 0); outside.dispose();
    const stale = fixture(); stale.onRequest = () => { stale.document.version++; };
    assert.equal(await stale.codeActions(), undefined); stale.dispose();
});

test('navigation providers gate capabilities and forward captured context and references', async () => {
    for (const [method, provider, call] of [
        ['definition', 'definitionProvider', 'provideDefinition'], ['typeDefinition', 'typeDefinitionProvider', 'provideTypeDefinition'],
        ['implementation', 'implementationProvider', 'provideImplementation'], ['references', 'referencesProvider', 'provideReferences']
    ]) {
        const f = fixture();
        const invoke = () => method === 'references'
            ? f[provider][call](f.document, f.cursor, { includeDeclaration: true }, f.token)
            : f[provider][call](f.document, f.cursor, f.token);
        assert.equal(await invoke(), undefined); assert.equal(f.clients[0].syncs.length, 0);
        f.capabilities[method + 'Provider'] = true; f.reply = [{ safe: 'mapper result' }];
        assert.deepEqual(await invoke(), f.reply); assert.equal(f.clients[0].requests[0].method, 'textDocument/' + method);
        assert.equal(f.navigationContext.root, f.folder.uri); assert.equal(f.navigationContext.files[0].path, 'main.ts');
        assert.equal(f.navigationContext.documents[0].text, f.text);
        if (method === 'references') { assert.deepEqual(f.clients[0].requests[0].params.context, { includeDeclaration: true }); }
        f.text = fence('<<piece>>') + fence('code', ': <<piece>>='); f.cursor = new Position(1, 4);
        assert.equal(await invoke(), undefined); f.dispose();
    }
});

test('signature help validates UTF16 offsets and clamps active indices', async () => {
    const f = fixture('call('), invoke = () => f.signatureProvider.provideSignatureHelp(f.document, f.cursor, f.token,
        { triggerKind: 1, isRetrigger: false });
    assert.equal(await invoke(), undefined); assert.equal(f.clients[0].syncs.length, 0);
    f.capabilities.signatureHelpProvider = { triggerCharacters: ['@'], retriggerCharacters: [';'] };
    f.reply = { signatures: [{ label: 'f(😀, x)', documentation: 'docs', parameters: [{ label: [2, 4] }, { label: 'x' }] }],
        activeSignature: 99, activeParameter: 1 };
    const help = await invoke(); assert.equal(help.activeSignature, 0); assert.equal(help.activeParameter, 1);
    assert.deepEqual(help.signatures[0].parameters[0].label, [2, 4]);
    assert.equal(help.signatures[0].documentation.isTrusted, false); assert.ok(f.signatureTriggers.includes('@'));
    assert.ok(f.signatureTriggers.includes(';')); assert.equal(f.clients[0].requests[0].params.context.triggerKind, 1);
    for (const label of [[-1, 2], [4, 2], [0, 100], [1.5, 2], 'missing']) {
        f.reply.signatures[0].parameters = [{ label }]; assert.equal(await invoke(), undefined);
    }
    f.reply = { signatures: [{ label: 'f(x)', activeParameter: -1, parameters: [{ label: 'x' }] }], activeSignature: -1 };
    assert.equal((await invoke()).activeParameter, 0); f.dispose();
});

test('automatic signature help survives cold startup and shares the manual gate', async () => {
    const f = fixture('call'); f.capabilities.signatureHelpProvider = {};
    f.reply = { signatures: [{ label: 'call(x)', parameters: [{ label: 'x' }] }] };
    f.type('('); await debounce(); assert.equal(f.hints, 1); assert.ok(f.signature);
    assert.equal(f.clients[0].requests[0].method, 'textDocument/signatureHelp');
    assert.deepEqual(f.clients[0].requests[0].params.context, { triggerKind: 2, triggerCharacter: '(', isRetrigger: false });
    assert.equal(f.clients[0].requests.length, 1); f.dispose();
});

test('background diagnostics sync without requests or focus and retain freshness across selection', async () => {
    const f = fixture(); f.languageDiagnostics = true; f.vscode.window.state.focused = false;
    f.events.emit('open', f.document); await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(f.clients.length, 1); assert.equal(f.clients[0].requests.length, 0);
    assert.equal(f.clients[0].syncs.length, 1); assert.equal(f.diagnosticSync.fresh(), true);
    const sync = f.diagnosticSync, invalidations = f.invalidations;
    f.select(new Position(1, 2)); f.events.emit('focus'); assert.equal(f.invalidations, invalidations);
    assert.equal(sync.fresh(), true);
    const generated = { ...f.document, uri: uri('/project/main.ts') };
    f.events.emit('change', { document: generated, contentChanges: [{ text: 'output noise' }] });
    f.events.emit('open', generated); f.events.emit('close', generated);
    assert.equal(f.invalidations, invalidations); assert.equal(sync.fresh(), true);
    f.type('x'); assert.equal(sync.fresh(), false); assert.ok(f.invalidations > invalidations);
    await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(f.clients[0].syncs.length, 2);
    f.languageDiagnostics = false; f.events.emit('config', { affectsConfiguration: () => false });
    assert.equal(f.diagnosticSync.fresh(), false); await f.complete(); assert.equal(f.clients[0].syncs.length, 3); f.dispose();
});

test('cold advertised signature trigger chooses signature after initialization', async () => {
    const f = fixture('call'); f.capabilities.signatureHelpProvider = { triggerCharacters: ['@'] };
    f.reply = { signatures: [{ label: 'call(x)' }] }; f.type('@'); await debounce();
    assert.equal(f.hints, 1); assert.equal(f.suggestions, undefined);
    assert.equal(f.clients[0].requests[0].method, 'textDocument/signatureHelp'); f.dispose();
});

test('background initialization yields to newest typing without poisoning the shared session', async () => {
    const f = fixture('this.'); f.languageDiagnostics = true;
    let release!: () => void; f.onInitialize = () => new Promise<void>(resolve => { release = resolve; });
    f.events.emit('open', f.document); await new Promise(resolve => setTimeout(resolve, 450));
    f.type('l'); f.type('i'); await debounce(); f.onInitialize = undefined; release(); await debounce();
    assert.equal(f.clients.length, 1); assert.equal(f.suggestions, 1); assert.equal(f.clients[0].requests.length, 1);
    assert.equal(f.diagnosticSync.fresh(), true);
    const invalidations = f.invalidations; f.stopClient(); assert.ok(f.invalidations > invalidations);
    assert.equal(await f.complete(), undefined); f.dispose(); assert.equal(f.stopUnsubscribed, true);
});

test('foreground snapshot failures, mismatches and removed outputs clear old diagnostics', async () => {
    for (const mutate of [
        (f: any) => { f.onSnapshot = () => { throw new Error('PRIVATE'); }; },
        (f: any) => { f.documents = [{ path: 'index.literate', text: 'stale' }]; },
        (f: any) => { f.documents = [{ path: 'index.literate', text: f.text }, { path: 'bad.literate', text: fence('<<missing>>') }]; },
        (f: any) => { f.text = 'No generated output remains'; f.cursor = new Position(0, 2); }
    ]) {
        const f = fixture(); f.languageDiagnostics = true; await f.complete();
        assert.equal(f.visibleDiagnostics, true); const key = f.diagnosticSync.key;
        mutate(f); assert.equal(await f.complete(), undefined);
        assert.equal(f.visibleDiagnostics, false); assert.equal(f.invalidatedKeys.at(-1), key);
        assert.doesNotMatch(f.logs.join(''), /PRIVATE/); f.dispose();
    }
});

test('snapshot errors still clear diagnostics after a focus change; request failures clear their session', async () => {
    for (const stage of ['onSnapshot', 'onRequest']) {
        const f = fixture(); f.languageDiagnostics = true; await f.complete();
        assert.equal(f.visibleDiagnostics, true);
        f[stage] = () => {
            if (stage === 'onSnapshot') { f.events.emit('focus'); }
            throw new Error('PRIVATE');
        };
        assert.equal(await f.complete(), undefined); assert.equal(f.visibleDiagnostics, false);
        assert.doesNotMatch(f.logs.join(''), /PRIVATE/); f.dispose();
    }
});

test('capture event overflow invalidates source freshness, not just the foreground epoch', async () => {
    const f = fixture(); f.languageDiagnostics = true;
    f.events.emit('open', f.document); await f.complete();
    const previous = f.diagnosticSync;
    f.onSnapshot = () => {
        for (let i = 0; i <= 1000; i++) { f.events.emit('disk', uri('/project/noise-' + i)); }
    };
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(previous.fresh(), false); assert.equal(f.visibleDiagnostics, false);
    assert.equal(f.clients[0].syncs.length, 1); f.dispose();
});

test('background snapshot errors and buffer mismatches clear existing diagnostics', async () => {
    for (const failure of [true, false]) {
        const f = fixture(); f.languageDiagnostics = true;
        // Schedule background capture, then publish diagnostics before its debounce expires.
        const other = { ...f.document, uri: uri('/project/other.literate') };
        f.events.emit('open', other); await f.complete(); assert.equal(f.visibleDiagnostics, true);
        if (failure) { f.onSnapshot = () => { throw new Error('PRIVATE'); }; }
        else { f.documents = [{ path: 'index.literate', text: 'stale' }]; }
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.equal(f.visibleDiagnostics, false); assert.doesNotMatch(f.logs.join(''), /PRIVATE/); f.dispose();
    }
});

test('explicit foreground requests wait behind background initialization and remain serialized', async () => {
    const f = fixture(); f.languageDiagnostics = true;
    let release!: () => void;
    f.onInitialize = () => new Promise<void>(resolve => { release = resolve; });
    f.events.emit('open', f.document); await new Promise(resolve => setTimeout(resolve, 450));
    const first = f.complete(), second = f.complete();
    await Promise.resolve(); assert.equal(f.clients[0].requests.length, 0);
    f.onInitialize = undefined; release();
    assert.equal((await first)[0].label, 'log'); assert.equal((await second)[0].label, 'log');
    assert.equal(f.clients.length, 1); assert.equal(f.clients[0].requests.length, 2); f.dispose();
});

test('queued foreground cancellation and view invalidation cannot replay stale requests', async () => {
    for (const cancel of [true, false]) {
        const f = fixture(); f.languageDiagnostics = true; let release!: () => void;
        f.onInitialize = () => new Promise<void>(resolve => { release = resolve; });
        f.events.emit('open', f.document); await new Promise(resolve => setTimeout(resolve, 450));
        const result = f.complete();
        if (cancel) { f.token.isCancellationRequested = true; f.events.emit('cancel'); }
        else { f.select(new Position(1, 2)); }
        f.onInitialize = undefined; release(); assert.equal(await result, undefined);
        await Promise.resolve(); assert.equal(f.clients[0].requests.length, 0);
        assert.equal(f.diagnosticSync.fresh(), true); f.dispose();
    }
});

test('signature triggers from other servers and retrigger-only characters do not steal completion', async () => {
    for (const retrigger of [true, false]) {
        const f = fixture('call');
        f.capabilities.signatureHelpProvider = { triggerCharacters: ['@'] };
        await f.complete(); assert.ok(f.signatureTriggers.includes('@'));
        f.capabilities.signatureHelpProvider = retrigger
            ? { triggerCharacters: ['('], retriggerCharacters: ['@'] } : { triggerCharacters: ['('] };
        f.capabilities.completionProvider.triggerCharacters = ['@'];
        f.type('@'); await debounce();
        assert.equal(f.suggestions, 1); assert.equal(f.hints, undefined);
        assert.equal(f.clients[0].requests.at(-1).method, 'textDocument/completion'); f.dispose();
    }
});

test('native automatic signature callbacks respect opt-out, focus, body and server triggers', async () => {
    for (const mutate of [
        (f: any) => { f.automaticCompletion = false; },
        (f: any) => { f.vscode.window.state.focused = false; },
        (f: any) => { f.text = 'prose('; f.cursor = new Position(0, 6); },
        (f: any) => { f.capabilities.signatureHelpProvider.triggerCharacters = ['@']; }
    ]) {
        const f = fixture('call('); f.capabilities.signatureHelpProvider = { triggerCharacters: ['('] }; mutate(f);
        const result = await f.signatureProvider.provideSignatureHelp(f.document, f.cursor, f.token,
            { triggerKind: 2, triggerCharacter: '(', isRetrigger: false });
        assert.equal(result, undefined); assert.equal(f.clients[0]?.requests.length ?? 0, 0); f.dispose();
    }
    const f = fixture('call('); f.automaticCompletion = false; f.capabilities.signatureHelpProvider = {};
    f.reply = { signatures: [{ label: 'call(x)' }] };
    assert.ok(await f.signatureProvider.provideSignatureHelp(f.document, f.cursor, f.token,
        { triggerKind: 1, isRetrigger: false })); f.dispose();
});

test('background template and configuration changes invalidate captured diagnostics', async () => {
    const f = fixture(); f.languageDiagnostics = true; f.templates = { 'wrapper.txt': 'prefix' };
    await f.complete(); const first = f.diagnosticSync;
    f.events.emit('disk', uri('/project/wrapper.txt')); assert.equal(first.fresh(), false);
    await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(f.diagnosticSync.fresh(), true);
    const second = f.diagnosticSync; f.events.emit('folders'); assert.equal(second.fresh(), false); f.dispose();
});

test('background diagnostics reject invalid, untrusted and opted-out inputs', async () => {
    for (const mutate of [
        (f: any) => { f.text = fence('<<missing>>'); }, (f: any) => { f.workspace.isTrusted = false; },
        (f: any) => { f.languageDiagnostics = false; }, (f: any) => { f.config = {}; }
    ]) {
        const f = fixture(); f.languageDiagnostics = true; mutate(f); f.events.emit('open', f.document);
        await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(f.clients.length, 0); f.dispose();
    }
});

function throwIfUnexpected(name: string) { assert.equal(name, 'node:path', 'adapter must not import generation or I/O'); }
const lspRange = (start: number, end: number, line = 0) => ({ start: { line, character: start }, end: { line, character: end } });
const debounce = () => new Promise(resolve => setTimeout(resolve, 240));

test('early Escape is enabled immediately in a named fragment before debounce or startup', async () => {
    const f = fixture('this'); f.capabilities.completionProvider.triggerCharacters = ['.'];
    f.type('.');
    assert.equal(f.snapshots, 0); assert.equal(f.clients.length, 0);
    assert.equal(f.pendingContext, true);
    if (f.pendingContext) { f.commands.get('literate.cancelAutomaticCompletion')(); }
    await debounce(); assert.equal(f.suggestions, undefined); assert.equal(f.snapshots, 0); f.dispose();
});

test('early Escape is scoped by shared Markdown tokens, not prose, headers or reference markers', () => {
    for (const [text, cursor] of [
        ['Prose this\n' + fence('this'), new Position(0, 10)],
        [fence('this'), new Position(0, 5)],
        [fence('this'), new Position(2, 0)],
        [fence('this', 'typescript'), new Position(1, 4)],
        [fence('<<piece>>') + fence('code', ': <<piece>>='), new Position(1, 4)],
        [fence('<<piece'), new Position(1, 7)],
        ['````text\n' + fence('this') + '````\n', new Position(2, 4)],
        [fence('code', 'zig: <<main.*>>= main.zig $'), new Position(1, 4)]
    ] as const) {
        const f = fixture(); f.text = text; f.select(cursor); f.type('x');
        assert.equal(f.pendingContext, false, text); assert.equal(f.snapshots, 0); f.dispose();
    }
    const f = fixture(); f.text = '~~~ts: <<main.*>>= main.ts $\nthis\n~~~\n'; f.select(new Position(1, 4));
    f.type('.'); assert.equal(f.pendingContext, true); f.dispose();
});

test('cold dot survives metadata and normal generation before first initialization', async () => {
    const f = fixture('this'); f.capabilities.completionProvider.triggerCharacters = ['.'];
    f.onSnapshot = () => {
        f.events.emit('change', { document: f.document, contentChanges: [] });
        for (const name of ['main.ts', 'index.html', '.literate-txn-first', '.literate-txn-first/0.stage', 'unrelated.txt']) {
            f.events.emit('create', uri('/project/' + name));
        }
    };
    f.type('.'); await debounce();
    assert.equal(f.suggestions, 1); assert.equal(f.snapshots, 1); assert.equal(f.clients.length, 1);
    assert.deepEqual(f.clients[0].requests[0].params.context, { triggerKind: 2, triggerCharacter: '.' }); f.dispose();
});

test('cold latest input survives publication and transaction output events during capture', async () => {
    const f = fixture(); f.text = fence('<<body>>') + fence('this', ': <<body>>=');
    f.select(new Position(4, 4)); f.capabilities.completionProvider.triggerCharacters = ['.'];
    let capture!: () => void;
    const generated = ['main.ts', 'index.html', '.literate-txn-first', '.literate-txn-first/0.stage', '.literate-txn-first/1.backup'];
    f.onSnapshot = () => {
        for (const name of generated) { f.events.emit('create', uri('/project/' + name)); }
        return new Promise<void>(resolve => { capture = resolve; });
    };
    f.type('.'); await debounce(); f.type('l'); f.type('i');
    f.onSnapshot = () => { for (const name of generated) { f.events.emit('delete', uri('/project/' + name)); } };
    capture(); await debounce();
    assert.equal(f.suggestions, 1); assert.equal(f.clients.length, 1); assert.equal(f.clients[0].requests.length, 1);
    assert.equal(f.clients[0].syncs[0][0].text, 'this.li\n'); f.dispose();
});

test('typing this.li lazily prefetches once and preserves an incomplete list', async () => {
    const f = fixture('this.'); f.reply = { isIncomplete: true, items: [{ label: 'list' }] };
    f.type('l'); f.type('i'); await debounce();
    assert.equal(f.clients.length, 1); assert.equal(f.clients[0].requests.length, 1);
    assert.equal(f.suggestions, 1); assert.equal(f.items.items[0].label, 'list'); assert.equal(f.items.isIncomplete, true);
    assert.equal(f.clients[0].requests[0].params.context.triggerKind, 1); f.dispose();
});

test('first mapped punctuation learns advertised triggers with LSP context 2', async () => {
    const f = fixture('this'); f.capabilities.completionProvider.triggerCharacters = ['@'];
    f.type('@'); await debounce(); assert.equal(f.suggestions, 1);
    assert.deepEqual(f.clients[0].requests[0].params.context, { triggerKind: 2, triggerCharacter: '@' }); f.dispose();
    const other = fixture('this'); other.type('!'); await debounce();
    assert.equal(other.clients.length, 1); assert.equal(other.clients[0].requests.length, 0);
    assert.equal(other.suggestions, undefined); other.dispose();
});

test('latest edit drains once when initialization or hover releases the gate', async () => {
    for (const hover of [false, true]) {
        const f = fixture('this.'); let release!: () => void;
        f.onInitialize = () => new Promise<void>(resolve => { release = resolve; });
        const manual = hover ? f.hover() : undefined;
        if (!hover) { f.type('l'); await debounce(); } else { await new Promise(resolve => setTimeout(resolve, 0)); }
        f.type('i'); f.type('s'); await debounce();
        assert.equal(f.clients.length, 1); assert.equal(f.clients[0].requests.length, 0);
        f.onInitialize = undefined; release(); await manual; await debounce();
        assert.equal(f.clients[0].requests.length, 1); assert.equal(f.suggestions, 1);
        assert.equal(f.clients[0].requests[0].params.position.character, hover ? 7 : 8); f.dispose();
    }
});

test('debounce rejects undo, paste, multiline, multicursor and resource optout', async () => {
    const fixtures = [fixture(), fixture(), fixture(), fixture(), fixture()];
    fixtures[0].type('x', 1); fixtures[1].type('paste'); fixtures[2].type('\n');
    fixtures[3].editor.selections.push(fixtures[3].editor.selection); fixtures[3].type('x');
    fixtures[4].automaticCompletion = false; fixtures[4].type('x');
    await debounce();
    for (const f of fixtures) { assert.equal(f.snapshots, 0); assert.equal(f.suggestions, undefined); f.dispose(); }
});

test('automatic eligibility rejects closed, nonlocal, untrusted, nonmarkdown and unconfigured documents', async () => {
    const mutations = [
        (f: any) => { f.document.isClosed = true; },
        (f: any) => { f.vscode.env.remoteName = 'ssh'; },
        (f: any) => { f.document.uri.scheme = 'untitled'; },
        (f: any) => { f.workspace.isTrusted = false; },
        (f: any) => { f.document.languageId = 'plaintext'; },
        (f: any) => { f.config = {}; },
        (f: any) => { f.vscode.window.state.focused = false; }
    ];
    const fixtures = mutations.map(mutate => { const f = fixture(); mutate(f); f.type('x'); return f; });
    await debounce();
    for (const f of fixtures) { assert.equal(f.snapshots, 0); assert.equal(f.suggestions, undefined); f.dispose(); }
    const f = fixture(); f.config = { zig: { command: '/bin/server' } }; f.type('x'); await debounce();
    assert.equal(f.clients.length, 0); assert.equal(f.suggestions, undefined); f.dispose();
});

test('automatic projection excludes prose, headers, reference tags and unmapped templates', async () => {
    const fixtures = [fixture(), fixture(), fixture(), fixture()];
    fixtures[0].text = 'prose\n' + fence('code'); fixtures[0].select(new Position(0, 2));
    fixtures[1].select(new Position(0, 5));
    fixtures[2].text = fence('<<piece>>') + fence('code', ': <<piece>>='); fixtures[2].select(new Position(1, 4));
    fixtures[3].text = fence('code', 'ts: <<main.*>>= main.ts "template" $'); fixtures[3].select(new Position(1, 2));
    for (const f of fixtures) { f.type('x'); } await debounce();
    for (const f of fixtures) { assert.equal(f.clients.length, 0); assert.equal(f.suggestions, undefined); f.dispose(); }
});

test('stale editor, focus, selection, trust, document and settings suppress prefetched UI', async () => {
    for (const mutate of [
        (f: any) => { f.vscode.window.activeTextEditor = { ...f.editor }; f.events.emit('editor'); },
        (f: any) => { f.vscode.window.state.focused = false; f.events.emit('focus'); },
        (f: any) => { f.select(new Position(1, 0)); },
        (f: any) => { f.select(f.cursor, 2); },
        (f: any) => { f.workspace.isTrusted = false; },
        (f: any) => { f.document.isClosed = true; },
        (f: any) => { f.document.version++; },
        (f: any) => { f.automaticCompletion = false; },
        (f: any) => { f.events.emit('config', { affectsConfiguration: () => false }); },
        (f: any) => { f.commands.get('literate.cancelAutomaticCompletion')(); }
    ]) {
        const f = fixture(); f.onRequest = () => mutate(f); f.type('x'); await debounce();
        assert.equal(f.suggestions, undefined); f.dispose();
    }
});

test('reset, Escape command and dispose clear pending timers; empty or unsafe items never open UI', async () => {
    const fixtures = [fixture(), fixture(), fixture()];
    for (const f of fixtures) { f.type('x'); }
    fixtures[0].restart(); fixtures[1].commands.get('literate.cancelAutomaticCompletion')(); fixtures[2].dispose();
    await debounce();
    for (const f of fixtures) { assert.equal(f.snapshots, 0); f.dispose(); }
    for (const reply of [[], [{ label: 'bad', insertTextFormat: 3 }], { items: [{ label: 'bad' }], itemDefaults: { command: {} } }]) {
        const f = fixture(); f.reply = reply; f.type('x'); await debounce();
        assert.equal(f.suggestions, undefined); f.dispose();
    }
});

test('local body context survives capture and Escape cancels initialization without touching widgets', async () => {
    const f = fixture(); let release!: () => void;
    f.onSnapshot = () => { assert.equal(f.pendingContext, true); };
    f.onInitialize = () => {
        assert.equal(f.pendingContext, true);
        return new Promise<void>(resolve => { release = resolve; });
    };
    f.type('x'); assert.deepEqual(f.contexts, [false, true]); await debounce();
    assert.deepEqual(f.contexts, [false, true]);
    f.commands.get('literate.cancelAutomaticCompletion')(); assert.equal(f.pendingContext, false);
    release(); await debounce(); assert.equal(f.suggestions, undefined); f.dispose();
    for (const text of ['prose\n', fence('code', 'zig: <<main.*>>= main.zig $')]) {
        const other = fixture(); other.text = text; other.select(new Position(text === 'prose\n' ? 0 : 1, 2));
        other.type('x'); await debounce(); assert.deepEqual(other.contexts, [false]); other.dispose();
    }
});

test('Escape binding stays enabled for queued identifiers throughout slow initialization', async () => {
    for (const waitForDebounce of [false, true]) {
        const f = fixture('this.'); let initialize!: () => void;
        f.onInitialize = () => new Promise<void>(resolve => { initialize = resolve; });
        f.type('l'); await debounce(); assert.equal(f.pendingContext, true);
        f.type('i'); assert.equal(f.pendingContext, true);
        f.type('s'); assert.deepEqual(f.contexts, [false, true]);
        if (waitForDebounce) { await debounce(); }
        let escaped = false;
        if (f.pendingContext) { f.commands.get('literate.cancelAutomaticCompletion')(); escaped = true; }
        assert.equal(escaped, true); assert.equal(f.pendingContext, false);
        f.onInitialize = undefined; initialize(); await debounce();
        assert.equal(f.suggestions, undefined); assert.equal(f.snapshots, 1);
        assert.equal(f.clients[0].requests.length, 0); f.dispose();
    }
});

test('mapped pending proof is not inherited after moves into prose, headers or reference tags', async () => {
    for (const cursor of [new Position(0, 2), new Position(1, 5), new Position(3, 4)]) {
        const f = fixture(); let initialize!: () => void;
        f.text = 'Prose\n' + fence('this.\n<<piece>>') + fence('value', ': <<piece>>=');
        f.select(new Position(2, 5));
        f.onInitialize = () => new Promise<void>(resolve => { initialize = resolve; });
        f.type('l'); await debounce(); assert.equal(f.pendingContext, true);
        f.select(cursor); assert.equal(f.pendingContext, false);
        f.type('i'); assert.equal(f.pendingContext, false); await debounce();
        f.onInitialize = undefined; initialize(); await debounce();
        assert.equal(f.pendingContext, false); assert.equal(f.suggestions, undefined); f.dispose();
    }
});

test('local body revalidation covers punctuation and version gaps but rejects undo and paste', async () => {
    for (const [mutate, expected] of [
        [(f: any) => { f.type('.'); }, true],
        [(f: any) => { f.type('i', 1); }, false],
        [(f: any) => { f.type('ij'); }, false],
        [(f: any) => { f.document.version++; f.type('i'); }, true],
        [(f: any) => { f.vscode.window.activeTextEditor = { ...f.editor }; f.type('i'); }, false],
        [(f: any) => { f.cursor = new Position(1, 0); f.editor.selection.active = f.cursor; f.type('i'); }, true]
    ] as const) {
        const f = fixture('this.'); let initialize!: () => void;
        f.onInitialize = () => new Promise<void>(resolve => { initialize = resolve; });
        f.type('l'); await debounce(); assert.equal(f.pendingContext, true);
        mutate(f); assert.equal(f.pendingContext, expected); await debounce();
        assert.equal(f.pendingContext, expected); f.dispose(); initialize(); await Promise.resolve();
        assert.equal(f.suggestions, undefined);
    }
});

test('older drain and delayed context acknowledgments cannot clear the newest mapped edit', async () => {
    const f = fixture(); let initialize!: () => void, reply!: () => void;
    const acknowledgments: (() => void)[] = [];
    f.onContext = () => new Promise<void>(resolve => { acknowledgments.push(resolve); });
    f.onInitialize = () => new Promise<void>(resolve => { initialize = resolve; });
    f.type('x'); await debounce(); assert.equal(f.pendingContext, true);
    f.type('y'); f.type('z'); await debounce(); assert.equal(f.pendingContext, true);
    f.onInitialize = undefined;
    f.onRequest = () => new Promise<void>(resolve => { reply = resolve; });
    initialize(); await debounce();
    assert.equal(f.pendingContext, true); assert.equal(f.clients[0].requests.length, 1);
    for (const acknowledge of acknowledgments.reverse()) { acknowledge(); }
    await Promise.resolve(); assert.equal(f.pendingContext, true);
    f.commands.get('literate.cancelAutomaticCompletion')(); assert.equal(f.pendingContext, false);
    reply(); await debounce(); assert.equal(f.suggestions, undefined); f.dispose();
});

test('consumed cache leaves normal widget cancellation inert and does not cancel later typing', async () => {
    const f = fixture(); f.type('x'); await debounce();
    assert.deepEqual(f.contexts, [false, true, false]);
    assert.equal(f.events.listenerCount('cancel'), 0);
    f.type('y'); f.events.emit('cancel'); await debounce();
    assert.equal(f.suggestions, 2); assert.equal(f.clients[0].requests.length, 2);
    assert.equal(f.pendingContext, false); f.dispose();
});

test('cancelled provider token clears only its matching cache, not a newer pending edit', async () => {
    const f = fixture();
    f.onSuggest = () => { f.token.isCancellationRequested = true; };
    f.type('x'); await debounce(); assert.equal(f.items, undefined); assert.equal(f.pendingContext, false);
    f.token.isCancellationRequested = false; f.onSuggest = undefined;
    const oldCursor = f.cursor; f.type('y');
    const cancelled = { ...f.token, isCancellationRequested: true };
    assert.equal(f.completionProvider.provideCompletionItems(f.document, oldCursor, cancelled, { triggerKind: 0 }), undefined);
    await debounce(); assert.equal(f.items[0].label, 'log'); assert.equal(f.clients[0].requests.length, 2); f.dispose();
});

test('empty content-change events preserve debounce and in-flight requests', async () => {
    const f = fixture();
    const metadata = () => f.events.emit('change', { document: f.document, contentChanges: [] });
    f.onSnapshot = metadata; f.onInitialize = metadata; f.onSync = metadata;
    f.onRequest = (signal: AbortSignal) => { metadata(); assert.equal(signal.aborted, false); };
    f.type('x'); metadata(); await debounce();
    assert.equal(f.suggestions, 1); assert.equal(f.snapshots, 1); f.dispose();
});

test('automatic capture ignores non-input disk events but detects newly discovered template changes', async () => {
    for (const event of ['disk', 'create', 'delete']) {
        const f = fixture(); f.onSnapshot = () => f.events.emit(event, uri('/project/main.ts'));
        f.type('x'); await debounce();
        assert.equal(f.suggestions, 1); assert.equal(f.snapshots, 1); assert.equal(f.clients[0].requests.length, 1); f.dispose();
    }
    for (const name of ['index.literate', 'new-template.txt', 'main.ts', 'index.html', '.literate-txn-first/0.stage']) {
        const f = fixture();
        if (name !== 'index.literate') { f.templates = { [name]: '[CODE]' }; }
        f.onSnapshot = () => f.events.emit('disk', uri('/project/' + name));
        f.type('x'); await debounce();
        assert.equal(f.suggestions, undefined, name); assert.equal(f.clients.length, 0, name);
        assert.deepEqual(f.contexts, [false, true, false]); f.dispose();
    }
});

test('generated-output noise cannot revive a capture cancelled by a newer edit or selection', async () => {
    for (const move of [false, true]) {
        const f = fixture(); let release!: () => void;
        f.onSnapshot = () => {
            f.events.emit('disk', uri('/project/main.ts'));
            return new Promise<void>(resolve => { release = resolve; });
        };
        f.type('x'); await debounce();
        if (move) { f.select(new Position(1, 0)); } else { f.type('y'); }
        f.onSnapshot = undefined; release(); await debounce();
        assert.equal(f.suggestions, move ? undefined : 1);
        assert.equal(f.snapshots, move ? 1 : 2); assert.equal(f.pendingContext, false); f.dispose();
    }
});

test('failed and empty drains plus restart and disposal always clear mapped pending context', async () => {
    for (const finish of ['empty', 'failure', 'restart', 'dispose']) {
        const f = fixture();
        f.onRequest = () => {
            assert.equal(f.pendingContext, true);
            if (finish === 'failure') { throw new Error('PRIVATE'); }
            if (finish === 'empty') { f.reply = []; }
            if (finish === 'restart') { f.restart(); }
            if (finish === 'dispose') { f.dispose(); }
        };
        f.type('x'); await debounce();
        assert.equal(f.pendingContext, false); assert.equal(f.suggestions, undefined);
        assert.doesNotMatch(f.logs.join(''), /PRIVATE/); f.dispose();
    }
});

test('chapter has bounded fragments and exactly assembles the owned output', () => {
    for (const match of chapter.matchAll(/```ts [^\n]+\n([\s\S]*?)\n```/g)) {
        assert.ok(match[1].split('\n').length <= 30, match[0].split('\n')[0]);
    }
    assert.equal(source, fs.readFileSync(path.join(root, 'src/language-features.ts'), 'utf8'));
    const generated = generatedFromBook('src/language-features.ts');
    assert.equal(generated.content, source);
});

test('selectors match markdown .literate files, with independent runtime guards', async () => {
    const f = fixture();
    const expected = { scheme: 'file', language: 'markdown', pattern: '**/*.literate' };
    assert.deepEqual(f.hoverSelector, expected); assert.deepEqual(f.completionSelector, expected);
    assert.deepEqual(f.codeActionSelector, expected);
    f.document.uri = uri('/project/readme.md');
    assert.equal(await f.hover(), undefined); assert.equal(await f.complete(), undefined);
    f.document.uri = uri('/project/index.literate'); f.document.languageId = 'plaintext';
    assert.equal(await f.complete(), undefined); assert.equal(f.snapshots, 0); f.dispose();
});

test('trust, locality, global-only settings and explicit invocation gate all snapshot work', async () => {
    for (const change of [
        (f: any) => { f.workspace.isTrusted = false; }, (f: any) => { f.vscode.env.remoteName = 'ssh'; },
        (f: any) => { f.folder.uri.authority = 'host'; }, (f: any) => { f.document.uri.scheme = 'untitled'; },
        (f: any) => { f.workspace.workspaceFolders = []; }, (f: any) => { f.config = undefined; },
        (f: any) => { f.config.typescript.command = 'server'; }, (f: any) => { f.config.typescript.args = 'bad'; },
        (f: any) => { f.config.typescript.configuration = []; }, (f: any) => { f.config = { ts: f.config.typescript }; }
    ]) {
        const f = fixture(); f.workspaceConfig = f.config; change(f);
        assert.equal(await f.complete(), undefined); assert.equal(f.snapshots, 0); assert.equal(f.clients.length, 0); f.dispose();
    }
    const f = fixture(); assert.equal(await f.complete(1), undefined); assert.equal(await f.complete(99), undefined);
    assert.equal(f.snapshots, 0); f.dispose();
});

test('unsaved snapshot, aliases and family synchronization; label edit replaces only source word', async () => {
    const f = fixture(); f.text += fence('export const x = 1;', 'js: <<other.*>>= other.js $');
    const [item] = await f.complete();
    assert.equal(item.label, 'log'); assert.equal(item.kind, 2);
    assert.deepEqual(item.range, new Range(new Position(1, 8), new Position(1, 10)));
    const client = f.clients[0];
    assert.deepEqual(client.syncs[0].map((d: any) => d.languageId), ['typescript', 'javascript']);
    assert.equal(client.syncs[0][0].text, 'console.lo\n');
    assert.equal(client.options.command, '/bin/server');
    assert.deepEqual(client.requests[0].params.position, { line: 0, character: 10 });
    await f.complete(); assert.equal(f.clients.length, 1); f.dispose(); assert.equal(client.disposed, 1);
});

test('omitted args default to an empty array and absent configuration stays quiet', async () => {
    const f = fixture(); delete f.config.typescript.args;
    assert.ok(await f.complete()); assert.deepEqual(f.clients[0].options.args, []);
    assert.equal(f.logs.length, 1); assert.match(f.logs[0], /ready: typescript; projected output "main.ts"/);
    f.config = undefined; f.events.emit('config', { affectsConfiguration: () => true });
    assert.equal(await f.complete(), undefined); assert.equal(f.logs.length, 1); f.dispose();
});

test('capabilities gate both methods before synchronization and requests', async () => {
    for (const capability of [undefined, false, null, 'unsupported', 1]) {
        const f = fixture(); f.capabilities = { hoverProvider: capability, completionProvider: capability };
        assert.equal(await f.hover(), undefined); assert.equal(await f.complete(), undefined);
        assert.equal(f.clients[0].requests.length, 0); assert.equal(f.clients[0].syncs.length, 0);
        assert.equal(f.logs.length, 1); assert.match(f.logs[0], /Language server ready/); f.dispose();
    }
    const f = fixture(); f.capabilities = { hoverProvider: {}, completionProvider: true };
    f.reply = { contents: 'supported hover' }; assert.ok(await f.hover());
    assert.equal(await f.complete(), undefined); f.dispose();
});

test('dot and empty prefix use insertion, not whole existing expression', async () => {
    const f = fixture('console.'); const [item] = await f.complete();
    assert.deepEqual(item.range, new Range(f.cursor, f.cursor)); f.dispose();
});

test('untrusted completion edits reject unsupported or unsafe variants and preserve metadata', async () => {
    const f = fixture();
    f.reply = [
        { label: 'ok', textEdit: { range: lspRange(8, 10), newText: 'log' }, sortText: 'a', filterText: 'lo', detail: 'detail', kind: 19 },
        { label: 'pair', textEdit: { insert: lspRange(8, 10), replace: lspRange(8, 10), newText: 'log' } },
        { label: 'command', command: {} }, { label: 'snippet', insertTextFormat: 2 }, { label: 'snippet kind', kind: 15 },
        { label: 'extra', additionalTextEdits: [{}] }, { label: 'badextra', additionalTextEdits: {} },
        { label: 'bad', textEdit: { range: lspRange(0, 100), newText: 'x' } },
        { label: 'notcursor', textEdit: { range: lspRange(0, 3), newText: 'x' } },
        { label: 'negative', textEdit: { range: lspRange(-1, 10), newText: 'x' } },
        { label: 'fraction', textEdit: { range: lspRange(8.5, 10), newText: 'x' } },
        { label: 'reverse', textEdit: { range: lspRange(10, 8), newText: 'x' } },
        { label: 'multiline', textEdit: { range: { start: { line: 0, character: 8 }, end: { line: 1, character: 0 } }, newText: 'x' } },
        { label: 'badpair', textEdit: { insert: lspRange(8, 10), replace: lspRange(9, 10), newText: 'x' } },
        { label: 'ambiguous', textEdit: { range: lspRange(8, 10), insert: lspRange(8, 10), newText: 'x' } },
        { label: 'default', textEditText: 'x' }, { label: 'badtext', insertText: 3 }, null
    ];
    const items = await f.complete(); assert.deepEqual(items.map((item: any) => item.label), ['ok', 'pair', 'snippet', 'snippet kind']);
    assert.equal(items[0].sortText, 'a'); assert.equal(items[0].filterText, 'lo'); assert.equal(items[0].detail, 'detail');
    assert.equal(items[0].kind, 18); assert.ok(items[1].range.inserting);
    f.reply = { items: [{ label: 'x' }], itemDefaults: {} }; assert.equal((await f.complete()).items[0].label, 'x');
    f.reply = { items: [{ label: 'x' }], editDefaults: {} }; assert.equal(await f.complete(), undefined); f.dispose();
});

test('hover is bounded untrusted Markdown and never widens unsafe ranges', async () => {
    const f = fixture();
    f.reply = { contents: { kind: 'markdown', value: '[run](command:evil)<script>x</script>' + 'a'.repeat(9000) } };
    const result = await f.hover(); assert.equal(result.contents[0].isTrusted, false);
    assert.equal(result.contents[0].supportHtml, false); assert.ok(result.contents[0].value.length <= 8192);
    assert.equal(result.range.start.character, 8);
    f.reply.range = lspRange(0, 999); assert.equal(await f.hover(), undefined);
    f.reply.range = null; assert.equal(await f.hover(), undefined);
    f.reply.range = lspRange(8, 10); assert.equal((await f.hover()).range.start.character, 8);
    f.reply = { contents: [{ language: 'ts', value: 'code' }, { kind: 'plaintext', value: '<plain>' }, 42] };
    assert.equal((await f.hover()).contents.length, 2); f.dispose();
});

test('invalid graphs, template roots, prose and reference markers never start clients', async () => {
    for (const [text, cursor] of [
        [fence('<<missing>>'), new Position(1, 3)],
        [fence('<<piece>>') + fence('code', ': <<piece>>='), new Position(1, 3)],
        ['prose\n' + fence('code'), new Position(0, 2)],
        [fence('code', 'ts: <<main.*>>= main.ts "template" $'), new Position(1, 2)]
    ] as const) {
        const f = fixture(); f.text = text; f.cursor = cursor;
        assert.equal(await f.complete(), undefined); assert.equal(f.clients.length, 0); f.dispose();
    }
});

test('captured templates support mapped hover and completion without leaking source into startup logs', async () => {
    const f = fixture('console.lo');
    f.text = fence('console.lo', 'ts: <<main.*>>= main.ts $ template=wrapper.txt');
    f.templates = { 'wrapper.txt': '// PRIVATE_TEMPLATE\n[CODE]' };
    assert.ok(await f.complete());
    assert.equal(f.clients[0].syncs[0][0].text, '// PRIVATE_TEMPLATE\nconsole.lo\n');
    assert.deepEqual(f.clients[0].requests[0].params.position, { line: 1, character: 10 });
    f.reply = { contents: 'hover', range: lspRange(8, 10, 1) };
    assert.ok(await f.hover()); assert.equal(f.logs.length, 1);
    assert.doesNotMatch(f.logs.join(''), /PRIVATE|console/); f.dispose();
});

test('projection failures diagnose safe root reasons once; prose, missing maps and unconfigured languages stay quiet', async () => {
    for (const [text, reason] of [
        [fence('code', 'ts: <<main.*>>= main.ts $ template=PRIVATE_TEMPLATE'), /missing template/],
        [fence('<<PRIVATE_FRAGMENT>>'), /missing fragment/],
        [fence('<<main.*>>'), /fragment cycle/]
    ] as const) {
        const f = fixture(); f.text = text;
        for (let i = 0; i < 4; i++) { assert.equal(await f.complete(), undefined); }
        assert.equal(f.logs.length, 1); assert.match(f.logs[0], reason);
        assert.doesNotMatch(f.logs[0], /PRIVATE/); assert.equal(f.clients.length, 0); f.dispose();
    }
    for (const text of ['ordinary prose', fence('code', 'zig: <<main.*>>= main.zig $'),
        fence('<<piece>>') + fence('code', ': <<piece>>=')]) {
        const f = fixture(); f.text = text; f.cursor = new Position(text === 'ordinary prose' ? 0 : 1, 3);
        assert.equal(await f.complete(), undefined); assert.deepEqual(f.logs, []); f.dispose();
    }
});

test('snapshot and server failures retain safe actionable categories without raw details', async () => {
    for (const stage of ['onSnapshot', 'onInitialize', 'onRequest']) {
        for (const [error, reason] of [
            [Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOENT' }), /ENOENT/],
            [new Error('LSP request timed out: PRIVATE_METHOD'), /request timeout/],
            [Object.assign(new Error('PRIVATE_ARGS'), { code: 'EACCES' }), /permission denied/]
        ] as const) {
            const f = fixture(); f[stage] = () => { throw error; };
            for (let i = 0; i < 4; i++) { assert.equal(await f.complete(), undefined); }
            assert.equal(f.logs.length, stage === 'onRequest' ? 2 : 1);
            assert.match(f.logs.at(-1), reason); assert.doesNotMatch(f.logs.join(''), /PRIVATE/); f.dispose();
        }
    }
});

test('template disk changes invalidate in-flight work across requests but generated outputs do not', async () => {
    for (const event of ['disk', 'create', 'delete']) {
        for (const stage of ['onSnapshot', 'onInitialize', 'onSync', 'onRequest']) {
            const f = fixture(); f.templates = { 'templates/wrapper.txt': '[CODE]' };
            assert.ok(await f.complete());
            f[stage] = () => f.events.emit(event, uri('/project/templates/wrapper.txt'));
            assert.equal(await f.complete(), undefined, event + ':' + stage); f.dispose();
        }
    }
    const capturing = fixture();
    capturing.templates = { 'new-template.txt': '[CODE]' };
    capturing.onSnapshot = () => capturing.events.emit('disk', uri('/project/new-template.txt'));
    assert.equal(await capturing.complete(), undefined); assert.equal(capturing.clients.length, 0); capturing.dispose();
    const f = fixture();
    f.onRequest = (signal: AbortSignal) => {
        f.events.emit('disk', uri('/project/main.ts')); assert.equal(signal.aborted, false);
    };
    assert.ok(await f.complete()); f.dispose();
});

test('freshness and cancellation checked after every async boundary', async () => {
    for (const stage of ['onSnapshot', 'onInitialize', 'onSync', 'onRequest']) {
        for (const mutate of [
            (f: any) => { f.document.version++; }, (f: any) => { f.events.emit('change', { document: f.document, contentChanges: [{}] }); },
            (f: any) => { f.events.emit('disk', uri('/project/other.literate')); }, (f: any) => { f.workspace.isTrusted = false; },
            (f: any) => { f.workspace.workspaceFolders = []; },
            (f: any) => { f.config.typescript.args.push('changed'); },
            (f: any) => { f.token.isCancellationRequested = true; f.events.emit('cancel'); }
        ]) {
            const f = fixture(); f[stage] = () => mutate(f);
            assert.equal(await f.complete(), undefined, stage); f.dispose();
        }
    }
    const f = fixture(); f.documents = [{ path: 'index.literate', text: fence('old disk') }];
    assert.equal(await f.complete(), undefined); assert.equal(f.clients.length, 0); f.dispose();
});

test('bounded waiting queue; document cancellation reaches requests and lifecycle catches disposal errors', async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.onRequest = async (signal: AbortSignal) => {
        f.signal = signal; entered(); await new Promise<void>(resolve => { release = resolve; });
    };
    const first = f.complete(); await ready;
    const queued = Array.from({ length: 32 }, () => f.complete());
    assert.equal(await f.complete(), undefined); assert.equal(f.snapshots, 1);
    f.events.emit('change', { document: f.document, contentChanges: [{}] }); assert.equal(f.signal.aborted, true);
    assert.deepEqual(await Promise.all(queued), Array(32).fill(undefined));
    release(); assert.equal(await first, undefined);
    f.onRequest = undefined; await f.complete();
    f.disposeFailure = true; f.events.emit('config', { affectsConfiguration: () => true });
    assert.equal(f.clients[0].disposed, 1); await f.complete(); assert.equal(f.clients.length, 2);
    f.workspace.workspaceFolders = []; f.events.emit('folders'); assert.equal(f.clients[1].disposed, 1);
    f.dispose(); await Promise.resolve();
});

test('invalid configuration diagnostics are actionable, deduplicated and bounded without secrets', async () => {
    const f = fixture(); f.config = { secret: { command: 'PRIVATE_COMMAND', args: ['PRIVATE_ARGUMENT'] } };
    for (let i = 0; i < 5; i++) { await f.complete(); }
    assert.equal(f.logs.length, 1); assert.match(f.logs[0], /global literate.languageServers/);
    assert.match(f.logs[0], /absolute executable/); assert.doesNotMatch(f.logs.join(''), /PRIVATE/);
    for (let i = 0; i < 105; i++) { f.restart(); await f.complete(); }
    assert.ok(f.clears > 0); assert.ok(f.logs.length <= 100);
    assert.equal(f.clients.length, 0); f.dispose(); assert.equal(f.channelDisposed, true);
});

test('failed sessions report once and stay disabled until an explicit restart, without retry loops', async () => {
    for (const stage of ['onInitialize', 'onSync', 'onRequest']) {
        const f = fixture(); let attempts = 0;
        f[stage] = () => { attempts++; throw new Error('PRIVATE_PROTOCOL_AND_SOURCE'); };
        assert.equal(await f.complete(), undefined);
        const count = stage === 'onInitialize' ? 1 : 2;
        assert.equal(f.clients[0].disposed, 1); assert.equal(f.logs.length, count);
        assert.match(f.logs.at(-1), /literate.restartLanguageServers/);
        assert.doesNotMatch(f.logs.join(''), /PRIVATE/);
        for (let i = 0; i < 3; i++) { assert.equal(await f.complete(), undefined); }
        assert.equal(attempts, 1); assert.equal(f.clients.length, 1); assert.equal(f.logs.length, count);
        f[stage] = undefined; f.restart(); assert.ok(await f.complete());
        assert.equal(f.clients.length, 2); assert.equal(f.clients[0].disposed, 1); f.dispose();
    }
});

test('restart during initialization invalidates old work without poisoning the new session', async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.onInitialize = async () => {
        entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error('old server exited');
    };
    const pending = f.complete(); await ready; f.restart();
    assert.equal(f.clients[0].disposed, 1); const next = f.complete();
    f.onInitialize = undefined; release(); assert.equal(await pending, undefined);
    assert.ok(await next); assert.equal(f.clients.length, 2);
    assert.equal(f.logs.length, 1); assert.match(f.logs[0], /Language server ready/); f.dispose();
});

test('cancelled protocol requests do not disable or diagnose a healthy session', async () => {
    const f = fixture(); f.onRequest = (signal: AbortSignal) => {
        f.events.emit('change', { document: f.document, contentChanges: [{}] }); assert.equal(signal.aborted, true); throw new Error('cancelled');
    };
    assert.equal(await f.complete(), undefined); assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /Language server ready/); assert.equal(f.clients[0].disposed, 0);
    f.onRequest = undefined; assert.ok(await f.complete()); assert.equal(f.clients.length, 1); f.dispose();
});

test('UTF16 positions and repeated mapping occurrence constrain edits', async () => {
    const f = fixture(); f.text = fence('<<piece>>\n<<piece>>') + fence('😀obj.lo', ': <<piece>>=');
    f.cursor = new Position(5, 8);
    f.reply = [{ label: 'first', textEdit: { range: lspRange(6, 8), newText: 'log' } },
        { label: 'other occurrence', textEdit: { range: lspRange(6, 8, 1), newText: 'log' } }];
    const result = await f.complete(); assert.deepEqual(result.map((v: any) => v.label), ['first']);
    assert.deepEqual(f.clients[0].requests[0].params.position, { line: 0, character: 8 });
    assert.equal(result[0].range.start.line, 5); f.dispose();
});
