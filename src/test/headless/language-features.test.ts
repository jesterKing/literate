/* Public VS Code/LSP API spellings are intentional in the isolated module mock. */
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-explicit-any */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { EventEmitter } from 'node:events';
import { generateProject } from '../../engine';
import * as projection from '../../language-projection';

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
    const f: any = { text: fence(body), config: { typescript: { command: '/bin/server', args: [] } }, clients,
        reply: [{ label: 'log', kind: 3 }], snapshots: 0, events, subscriptions, logs: [], commands: new Map(),
        capabilities: { hoverProvider: true, completionProvider: {} } };
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
    const workspace: any = { isTrusted: true, workspaceFolders: [folder], getWorkspaceFolder: () => workspace.workspaceFolders[0],
        getConfiguration: () => ({ inspect: (key: string) => {
            assert.equal(key, 'languageServers'); return { globalValue: f.config, workspaceValue: f.workspaceConfig };
        }, get() { throw new Error('Merged settings are forbidden'); } }),
        onDidChangeConfiguration: event('config'), onDidChangeWorkspaceFolders: event('folders'),
        onDidChangeTextDocument: event('change'), onDidOpenTextDocument: event('open'), onDidCloseTextDocument: event('close'),
        createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event('disk'), onDidCreate: event('disk'), onDidDelete: event('disk') }) };
    const token: any = { isCancellationRequested: false, onCancellationRequested: event('cancel') };
    const vscode: any = { workspace, env: {}, Uri: { file: uri }, Position, Range, CompletionTriggerKind: { Invoke: 0 },
        window: { createOutputChannel: (name: string) => {
            assert.equal(name, 'Literate Language Servers');
            return { appendLine: (line: string) => f.logs.push(line), clear: () => { f.logs = []; f.clears = (f.clears || 0) + 1; },
                dispose: () => { f.channelDisposed = true; } };
        } },
        commands: { registerCommand: (name: string, callback: () => void) => {
            f.commands.set(name, callback); return { dispose: () => f.commands.delete(name) };
        } },
        CompletionItemKind: { Text: 0, Method: 1, Function: 2, Folder: 18 },
        CompletionItem: class { constructor(public label: string) {} },
        MarkdownString: class { value = ''; appendMarkdown(s: string) { this.value += s; } appendText(s: string) { this.value += s; }
            appendCodeblock(s: string, lang: string) { this.value += lang + '\n' + s; } },
        Hover: class { constructor(public contents: any, public range: any) {} },
        languages: {
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
        if (name === './language-client') { return { LanguageClient: Client }; }
        if (name === './language-projection') { return projection; }
        throwIfUnexpected(name); return require(name);
    }, exports);
    exports.registerLanguageFeatures({ subscriptions }, async (value: any) => {
        assert.equal(value, folder); f.snapshots++; await f.onSnapshot?.();
        return f.documents ?? [{ path: 'index.literate', text: f.text }];
    });
    Object.assign(f, { vscode, workspace, document, token, folder, cursor: new Position(1, body.length),
        complete: (kind = 0) => f.completionProvider.provideCompletionItems(document, f.cursor, token, { triggerKind: kind }),
        hover: () => f.hoverProvider.provideHover(document, f.cursor, token),
        restart: () => f.commands.get('literate.restartLanguageServers')(),
        dispose: () => subscriptions.forEach(item => item.dispose()) });
    return f;
}
function throwIfUnexpected(name: string) { assert.equal(name, 'node:path', 'adapter must not import generation or I/O'); }
const lspRange = (start: number, end: number, line = 0) => ({ start: { line, character: start }, end: { line, character: end } });

test('chapter has bounded fragments and exactly assembles the owned output', () => {
    for (const chunk of chunks) { assert.ok(chunk.split('\n').length <= 30); }
    assert.equal(source, fs.readFileSync(path.join(root, 'src/language-features.ts'), 'utf8'));
    const generated = generateProject([{ path: 'language-features.literate', text: chapter }]);
    assert.deepEqual(generated.diagnostics, []);
    assert.equal(generated.files.find(file => file.path === 'src/language-features.ts')?.content, source);
});

test('selectors match markdown .literate files, with independent runtime guards', async () => {
    const f = fixture();
    const expected = { scheme: 'file', language: 'markdown', pattern: '**/*.literate' };
    assert.deepEqual(f.hoverSelector, expected); assert.deepEqual(f.completionSelector, expected);
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
    const f = fixture(); assert.equal(await f.complete(1), undefined); assert.equal(await f.complete(2), undefined);
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
    assert.ok(await f.complete()); assert.deepEqual(f.clients[0].options.args, []); assert.deepEqual(f.logs, []);
    f.config = undefined; f.events.emit('config', { affectsConfiguration: () => true });
    assert.equal(await f.complete(), undefined); assert.deepEqual(f.logs, []); f.dispose();
});

test('capabilities gate both methods before synchronization and requests', async () => {
    for (const capability of [undefined, false, null, 'unsupported', 1]) {
        const f = fixture(); f.capabilities = { hoverProvider: capability, completionProvider: capability };
        assert.equal(await f.hover(), undefined); assert.equal(await f.complete(), undefined);
        assert.equal(f.clients[0].requests.length, 0); assert.equal(f.clients[0].syncs.length, 0);
        assert.deepEqual(f.logs, []); f.dispose();
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
    const items = await f.complete(); assert.deepEqual(items.map((item: any) => item.label), ['ok', 'pair']);
    assert.equal(items[0].sortText, 'a'); assert.equal(items[0].filterText, 'lo'); assert.equal(items[0].detail, 'detail');
    assert.equal(items[0].kind, 18); assert.ok(items[1].range.inserting);
    f.reply = { items: [{ label: 'x' }], itemDefaults: {} }; assert.equal(await f.complete(), undefined);
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

test('freshness and cancellation checked after every async boundary', async () => {
    for (const stage of ['onSnapshot', 'onInitialize', 'onSync', 'onRequest']) {
        for (const mutate of [
            (f: any) => { f.document.version++; }, (f: any) => { f.events.emit('change', {}); },
            (f: any) => { f.events.emit('disk'); }, (f: any) => { f.workspace.isTrusted = false; },
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

test('no waiting queue; document cancellation reaches request and lifecycle catches disposal errors', async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.onRequest = async (signal: AbortSignal) => {
        f.signal = signal; entered(); await new Promise<void>(resolve => { release = resolve; });
    };
    const first = f.complete(); await ready;
    assert.equal(await f.complete(), undefined); assert.equal(f.snapshots, 1);
    f.events.emit('change', {}); assert.equal(f.signal.aborted, true); release(); assert.equal(await first, undefined);
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
        assert.equal(f.clients[0].disposed, 1); assert.equal(f.logs.length, 1);
        assert.match(f.logs[0], /literate.restartLanguageServers/);
        assert.doesNotMatch(f.logs[0], /PRIVATE/);
        for (let i = 0; i < 3; i++) { assert.equal(await f.complete(), undefined); }
        assert.equal(attempts, 1); assert.equal(f.clients.length, 1); assert.equal(f.logs.length, 1);
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
    assert.equal(f.clients[0].disposed, 1); assert.equal(await f.complete(), undefined);
    release(); assert.equal(await pending, undefined); assert.deepEqual(f.logs, []);
    f.onInitialize = undefined; assert.ok(await f.complete()); assert.equal(f.clients.length, 2); f.dispose();
});

test('cancelled protocol requests do not disable or diagnose a healthy session', async () => {
    const f = fixture(); f.onRequest = (signal: AbortSignal) => {
        f.events.emit('change', {}); assert.equal(signal.aborted, true); throw new Error('cancelled');
    };
    assert.equal(await f.complete(), undefined); assert.deepEqual(f.logs, []); assert.equal(f.clients[0].disposed, 0);
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
