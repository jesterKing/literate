/* Protocol and VS Code spellings are intentional. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type * as vscode from 'vscode';
import type { LanguageClient, LanguageDocument } from '../../language-client';
import type { LanguageLocationContext } from '../../language-navigation';
import type { SourceDocument } from '../../engine';
import { projectLanguageSources } from '../../language-projection';
import { Position, Range, fence, tick } from './vscode-fixture';
import { generatedFromBook } from './authoritative-book';

const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'src/language-diagnostics.ts'), 'utf8');
const navigation = fs.readFileSync(path.join(root, 'src/language-navigation.ts'), 'utf8');
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
class Diagnostic {
    constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}
function load(text: string, dependencies: Record<string, unknown>): Record<string, any> {
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
    }).outputText)((name: string) => {
        assert.ok(name in dependencies, `No I/O dependency allowed: ${name}`);
        return dependencies[name];
    }, exports);
    return exports;
}
class Client {
    capabilities: Record<string, unknown> = {};
    versions = new Map<string, number>();
    sequence = 0;
    documents = new Map<string, LanguageDocument>();
    syncCalls = 0;
    listeners = new Map<string, Set<(value: unknown) => void>>();
    stops = new Set<() => void>();
    duringSync?: () => Promise<void> | void;
    requests: { params: any; signal?: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    onNotification(method: string, callback: (value: unknown) => void) {
        if (!this.listeners.has(method)) { this.listeners.set(method, new Set()); }
        this.listeners.get(method)!.add(callback);
        return () => { this.listeners.get(method)!.delete(callback); };
    }
    onDidStop(callback: () => void) { this.stops.add(callback); return () => { this.stops.delete(callback); }; }
    documentVersion(uri: string) { return this.versions.get(uri); }
    async sync(documents: LanguageDocument[]) {
        this.syncCalls++;
        const next = new Map(documents.map(document => [document.uri, { ...document }]));
        for (const uri of this.documents.keys()) {
            if (!next.has(uri)) { this.versions.delete(uri); }
        }
        for (const document of documents) {
            const old = this.documents.get(document.uri);
            if (old?.text !== document.text || old?.languageId !== document.languageId) {
                this.versions.set(document.uri, ++this.sequence);
            }
        }
        this.documents = next;
        await this.duringSync?.();
    }
    emit(method: string, value?: unknown) { for (const cb of this.listeners.get(method) || []) { cb(value); } }
    push(uri: string, diagnostics: unknown[], version?: number) {
        this.emit('textDocument/publishDiagnostics', { uri, diagnostics, ...(version === undefined ? {} : { version }) });
    }
    request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        assert.equal(method, 'textDocument/diagnostic');
        return new Promise((resolve, reject) => { this.requests.push({ params, signal, resolve, reject }); });
    }
    stop() { for (const callback of [...this.stops]) { callback(); } }
}
const uri = 'file:///project/main.ts';
const range = (line = 0, start = 0, end = 1) => ({ start: { line, character: start }, end: { line, character: end } });
const issue = (message = 'problem', line = 0) => ({ range: range(line), message, severity: 2 });
function fixture(documents: SourceDocument[] = [
    { path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $', 'abc') }
], templates: Record<string, string> = {}) {
    const problems = new Map<string, vscode.Diagnostic[]>(), logs: string[] = [];
    let disposed = false, clears = 0;
    const api = { Uri, Position, Range, Location, Diagnostic, DiagnosticSeverity: { Error: 0 }, languages: {
        createDiagnosticCollection(name: string) {
            assert.equal(name, 'literate-language');
            return { clear() { clears++; problems.clear(); }, dispose() { disposed = true; problems.clear(); },
                set(entries: [Uri, vscode.Diagnostic[]][]) { for (const [uri, values] of entries) { problems.set(uri.toString(), values); } } };
        }
    } };
    const mapper = load(navigation, { vscode: api, 'node:path': path });
    const exported = load(source, { vscode: api, 'node:path': path, './language-navigation': mapper });
    const subscriptions: vscode.Disposable[] = [];
    const controller: import('../../language-diagnostics').LanguageDiagnostics = new exported.LanguageDiagnostics({ subscriptions }, (value: string) => logs.push(value));
    const projection = projectLanguageSources(documents, templates);
    assert.deepEqual(projection.diagnostics, []);
    const context: LanguageLocationContext = { root: Uri.file('/project') as unknown as vscode.Uri, files: projection.files, documents };
    const docs = projection.files.map(file => ({ uri: Uri.file(path.resolve('/project', file.path)).toString(), languageId: 'typescript', text: file.content }));
    let fresh = true;
    const sync = (client: Client, key = 'one') => controller.synchronize(key, client as unknown as LanguageClient, context, docs, () => fresh);
    return { controller, context, docs, sync, problems, logs, subscriptions, stale() { fresh = false; },
        all: () => [...problems.values()].flat(), disposed: () => disposed, clears: () => clears,
        edit(text: string) {
            context.documents = [{ ...context.documents[0], text }];
            context.files = projectLanguageSources(context.documents, templates).files;
            docs.splice(0, docs.length, ...context.files.map(file => ({
                uri: Uri.file(path.resolve('/project', file.path)).toString(), languageId: 'typescript', text: file.content })));
        } };
}

test('chapter assembles the owned source exactly with snippets no longer than thirty lines', () => {
    const chapter = fs.readFileSync(path.join(root, 'literate/language-diagnostics.literate'), 'utf8');
    assert.equal(generatedFromBook('src/language-diagnostics.ts').content, source);
    for (const match of chapter.matchAll(/```ts[^\n]*\n([\s\S]*?)\n```/g)) { assert.ok(match[1].split('\n').length <= 30); }
});

test('push stages matching versions before sync returns; suppresses unversioned in-flight and rejects late versions', async () => {
    const f = fixture(), client = new Client();
    let release!: () => void;
    client.duringSync = () => {
        client.push(uri, [issue('staged')], client.documentVersion(uri));
        return new Promise<void>(resolve => { release = resolve; });
    };
    const syncing = f.sync(client); await tick();
    assert.equal(f.all().length, 0); release(); await syncing;
    assert.equal(f.all()[0].message, 'staged');
    const version = client.documentVersion(uri)!;
    client.push(uri, [issue('late')], version - 1);
    assert.equal(f.all()[0].message, 'staged');
    client.push(uri, [issue('best effort')]); assert.equal(f.all()[0].message, 'best effort');
    client.duringSync = () => { client.push(uri, [issue('ambiguous')]); };
    f.controller.invalidate('one');
    f.edit(fence('ts: <<main.*>>= main.ts $', 'def'));
    await f.sync(client); assert.equal(f.all().length, 0);
    client.push(uri, [issue('old')], version); assert.equal(f.all().length, 0);
    client.push(uri, [issue('new')], client.documentVersion(uri)); assert.equal(f.all().length, 1);
    f.controller.invalidate('one'); assert.equal(f.all().length, 0);
    client.push(uri, [issue()]); assert.equal(f.all().length, 0);
    assert.equal(client.stops.size, 1, 'cache stop listener survives source invalidation');
    assert.ok([...client.listeners.values()].every(listeners => listeners.size === 0));
    client.stop(); assert.equal(client.stops.size, 0);
});

test('unchanged synchronization retains pushes without republishing, clearing, or redundant wire sync', async () => {
    for (const versioned of [true, false]) {
        const f = fixture(), client = new Client(); await f.sync(client);
        const version = client.documentVersion(uri)!;
        client.push(uri, [issue()], versioned ? version : undefined);
        const diagnostic = f.all()[0], clears = f.clears();
        await f.sync(client); await f.sync(client);
        assert.equal(client.documentVersion(uri), version); assert.equal(client.syncCalls, 1);
        assert.equal(f.all()[0], diagnostic); assert.equal(f.clears(), clears);
        f.controller.dispose();
    }
});

test('identical snapshots retain active pulls and update the freshness callback', async () => {
    const f = fixture(), client = new Client(); client.capabilities.diagnosticProvider = {};
    await f.sync(client); await tick(); const clears = f.clears();
    f.stale();
    await f.controller.synchronize('one', client as unknown as LanguageClient, f.context, f.docs, () => true);
    assert.equal(client.requests.length, 1); assert.equal(client.requests[0].signal?.aborted, false);
    assert.equal(f.clears(), clears);
    client.requests[0].resolve({ kind: 'full', items: [issue()] }); await tick();
    assert.equal(f.all().length, 1); f.controller.dispose();
});

test('source invalidation restores raw reports at shifted prose lines only for the same wire version', async () => {
    for (const versioned of [true, false]) {
        const f = fixture(), client = new Client(); await f.sync(client);
        const version = client.documentVersion(uri)!;
        const original = { ...issue(), data: { ignored: 'do not cache' }, relatedInformation: [{ message: 'ignored' }] };
        client.push(uri, [original], versioned ? version : undefined);
        assert.equal(f.all()[0].range.start.line, 1);
        original.message = 'mutated'; original.range.start.line = 99;
        f.controller.invalidate(); assert.equal(f.all().length, 0);
        client.push(uri, [issue('between snapshots')]);
        f.edit('New prose.\n\n' + f.context.documents[0].text);
        await f.sync(client);
        assert.equal(client.documentVersion(uri), version);
        assert.equal(f.all()[0].range.start.line, 3); assert.equal(f.all()[0].message, 'problem');
        assert.equal(f.all()[0].relatedInformation, undefined);
        f.controller.invalidate(); f.edit(f.context.documents[0].text.replace('abc', 'def'));
        await f.sync(client); assert.notEqual(client.documentVersion(uri), version); assert.equal(f.all().length, 0);
        client.push(uri, [issue('late old version')], version); assert.equal(f.all().length, 0);
        f.controller.invalidate(); f.edit(f.context.documents[0].text.replace('def', 'abc'));
        await f.sync(client); assert.equal(f.all().length, 0, 'returning to old text cannot revive an old wire version');
        f.controller.dispose();
    }
});

test('empty reports supersede cached problems and stopped/replaced clients cannot restore old reports', async () => {
    const f = fixture(), client = new Client(); await f.sync(client); client.push(uri, [issue()]);
    client.push(uri, []); f.controller.invalidate(); await f.sync(client); assert.equal(f.all().length, 0);
    client.push(uri, [issue()]); f.controller.invalidate(); client.stop();
    assert.equal(client.stops.size, 0);
    await f.sync(client); assert.equal(f.all().length, 0, 'stop purges cache even with no active session');
    client.push(uri, [issue()]);
    const replacement = new Client(); await f.sync(replacement);
    assert.equal(replacement.documentVersion(uri), client.documentVersion(uri));
    assert.equal(f.all().length, 0, 'equal versions from different clients must never share reports');
    f.controller.dispose(); assert.equal(client.stops.size, 0); assert.equal(replacement.stops.size, 0);
});

test('raw caches bound clients, URIs, item counts, and bytes and release on dispose', async () => {
    const documents = Array.from({ length: 70 }, (_, index) => ({ path: `source${index}.literate`,
        text: fence(`ts: <<file${index}.*>>= file${index}.ts $`, 'abc') }));
    const f = fixture(documents), client = new Client(); await f.sync(client);
    const caches = (f.controller as unknown as { caches: Map<Client, {
        reports: Map<string, { items: unknown[]; bytes: number }>;
    }> }).caches;
    for (const doc of f.docs) { client.push(doc.uri, [issue()]); }
    assert.equal(caches.get(client)!.reports.size, 64);
    for (const doc of f.docs.slice(0, 6)) {
        client.push(doc.uri, Array.from({ length: 1000 }, (_, index) => issue(String(index))));
    }
    assert.ok([...caches.get(client)!.reports.values()].reduce((count, report) => count + report.items.length, 0) <= 5000);
    client.push(f.docs[0].uri, Array.from({ length: 1000 }, () => issue('x'.repeat(8192))));
    assert.ok([...caches.get(client)!.reports.values()].reduce((bytes, report) => bytes + report.bytes, 0) <= 4 * 1024 * 1024);
    f.controller.invalidate(); await f.sync(client);
    assert.ok(f.all().length <= 5000);
    for (let index = 0; index < 17; index++) {
        const next = new Client(); await f.sync(next); next.push(f.docs[0].uri, [issue()]); f.controller.invalidate();
    }
    assert.equal(caches.size, 16);
    f.controller.dispose(); assert.equal(caches.size, 0); assert.equal(client.stops.size, 0);
});

test('ownership, freshness, metadata validation and unsafe fields are bounded without I/O', async () => {
    const f = fixture(), client = new Client(); await f.sync(client);
    client.push('file:///lib/library.ts', [issue()]); assert.equal(f.all().length, 0);
    client.push(uri, [null, {}, { ...issue(), message: 4 }, { ...issue(), range: range(99) },
        { ...issue(), message: 'x'.repeat(9000), code: 'c'.repeat(300), source: 's'.repeat(300),
            severity: 99, tags: [1, 1, 2, 3], codeDescription: { href: 'command:danger' }, relatedInformation: [{}] }]);
    const value = f.all()[0];
    assert.equal(f.all().length, 1); assert.equal(value.message.length, 8192);
    assert.equal((value.code as string).length, 256); assert.equal(value.source?.length, 256);
    assert.equal(value.severity, 0); assert.deepEqual(value.tags, [1, 2]);
    assert.equal(value.relatedInformation, undefined); assert.ok(f.logs.some(value => value.includes('1 unmapped')));
    client.push(uri, [issue('invalid version')], NaN); assert.equal(f.all()[0], value);
    f.stale(); client.push(uri, [issue('stale')]); assert.equal(f.all()[0], value);
    f.controller.invalidate(); assert.equal(f.all().length, 0);
});

test('pull is preferred, nonblocking, correlated, full only and ignores related documents', async () => {
    const f = fixture(), client = new Client(); client.capabilities.diagnosticProvider = { identifier: 'test' };
    await f.sync(client); await tick(); assert.equal(client.requests.length, 1);
    client.push(uri, [issue('push')]); assert.equal(f.all().length, 0);
    assert.deepEqual(client.requests[0].params, { textDocument: { uri }, identifier: 'test' });
    client.requests[0].resolve({ kind: 'full', items: [issue('pull')], resultId: 'r',
        relatedDocuments: { [uri]: { kind: 'full', items: [issue('related')] } } });
    await tick(); assert.equal(f.all()[0].message, 'pull');
    for (let i = 0; i < 20; i++) { client.emit('workspace/diagnostic/refresh'); }
    await tick(); assert.equal(client.requests.length, 2);
    assert.equal(client.requests[1].params.previousResultId, undefined);
    client.requests[1].resolve({ kind: 'unchanged', resultId: 'r' }); await tick();
    assert.equal(f.all()[0].message, 'pull');
    client.emit('workspace/diagnostic/refresh'); await tick();
    f.controller.invalidate(); assert.ok(client.requests[2].signal?.aborted); assert.equal(f.all().length, 0);
    client.requests[2].resolve({ kind: 'full', items: [issue('late')] }); await tick(); assert.equal(f.all().length, 0);
    await f.sync(client); await tick();
    client.requests[3].reject(new Error('failed')); await tick(); await tick();
    assert.equal(client.requests.length, 4); assert.equal(f.logs.length, 1);
});

test('stale pull cannot affect a replacement generation or publish a changed document version', async () => {
    const f = fixture(), client = new Client(); client.capabilities.diagnosticProvider = {};
    await f.sync(client); await tick();
    f.controller.invalidate();
    await f.sync(client); await tick(); assert.ok(client.requests[0].signal?.aborted);
    client.requests[0].resolve({ kind: 'full', items: [issue('old')] }); await tick(); assert.equal(f.all().length, 0);
    client.versions.set(uri, 100);
    client.requests[1].resolve({ kind: 'full', items: [issue('wrong version')] }); await tick(); assert.equal(f.all().length, 0);
    await f.sync(client); await tick(); f.stale();
    client.requests[2].resolve({ kind: 'full', items: [issue('not fresh')] }); await tick(); assert.equal(f.all().length, 0);
});

test('repeated expansions and output/session reports deduplicate while stop retains other sessions', async () => {
    const f = fixture([{ path: 'index.literate', text:
        fence('ts: <<main.*>>= main.ts $', '<<child>>\n<<child>>') +
        fence('ts: <<other.*>>= other.ts $', '<<child>>') + fence('ts: <<child>>=', 'abc') }]);
    const a = new Client(), b = new Client(); await f.sync(a); await f.sync(b, 'two');
    a.push(uri, [issue(), issue('problem', 1)]); a.push('file:///project/other.ts', [issue()]);
    b.push(uri, [issue()]); assert.equal(f.all().length, 1);
    a.push(uri, []); assert.equal(f.all().length, 1);
    b.stop(); assert.equal(f.all().length, 1); a.stop(); assert.equal(f.all().length, 0);
    assert.equal(a.stops.size, 0); assert.equal(b.stops.size, 0);
    assert.equal(f.subscriptions[0], f.controller); f.controller.dispose(); f.controller.dispose(); assert.ok(f.disposed());
});

test('sync failures clear and detach; invalidating a pending sync prevents publication', async () => {
    const f = fixture(), client = new Client();
    client.duringSync = () => { throw new Error('sync failure'); };
    await assert.rejects(f.sync(client), /sync failure/); assert.equal(client.stops.size, 0);
    let release!: () => void;
    client.duringSync = () => new Promise<void>(resolve => { release = resolve; });
    const pending = f.sync(client); await tick();
    client.push(uri, [issue()], client.documentVersion(uri));
    f.controller.invalidate(); release(); await pending; assert.equal(f.all().length, 0);
});

test('refresh pull cycles are single-concurrency, capped at 64 documents and do not self-repeat', async () => {
    const text = Array.from({ length: 70 }, (_, i) => fence(`ts: <<file${i}.*>>= file${i}.ts $`, 'abc')).join('');
    const f = fixture([{ path: 'index.literate', text }]), client = new Client();
    client.capabilities.diagnosticProvider = {};
    await f.sync(client); await tick();
    for (let i = 0; i < 64; i++) {
        assert.equal(client.requests.length, i + 1);
        client.emit('workspace/diagnostic/refresh');
        client.requests[i].resolve({ kind: 'full', items: [] }); await tick();
    }
    await tick(); assert.equal(client.requests.length, 64);
});

test('repeated template slots deduplicate and wrapper-only ranges are logged, never fabricated', async () => {
    const f = fixture([{ path: 'index.literate', text: fence('ts: <<main.*>>= main.ts $ template=wrap', 'abc') }],
        { wrap: 'wrapper\n[CODE]separator\n[CODE]tail' });
    const client = new Client(); await f.sync(client);
    client.push(uri, [issue('wrapper'), issue('literal', 1), issue('literal', 3)]);
    assert.equal(f.all().length, 1); assert.equal(f.all()[0].message, 'literal');
    assert.equal(f.all()[0].range.start.line, 1); assert.equal(f.logs.length, 1);
});

test('stopping and disposing abort pending pulls and detach all listeners', async () => {
    const f = fixture(), client = new Client(); client.capabilities.diagnosticProvider = {};
    await f.sync(client); await tick(); client.stop();
    assert.ok(client.requests[0].signal?.aborted); assert.equal(client.stops.size, 0);
    client.requests[0].resolve({ kind: 'full', items: [issue()] }); await tick(); assert.equal(f.all().length, 0);
    await f.sync(client); await tick(); f.controller.dispose();
    assert.ok(client.requests[1].signal?.aborted); assert.equal(client.stops.size, 0);
    assert.ok([...client.listeners.values()].every(listeners => listeners.size === 0));
    client.requests[1].resolve({ kind: 'full', items: [issue()] }); await tick(); assert.equal(f.all().length, 0);
});

test('session budgets cap aggregate reports at five thousand across source files', async () => {
    const documents = Array.from({ length: 6 }, (_, index) => ({ path: `source${index}.literate`,
        text: fence(`ts: <<file${index}.*>>= file${index}.ts $`, 'abc') }));
    const f = fixture(documents), client = new Client(); await f.sync(client);
    for (const doc of f.docs) {
        client.push(doc.uri, Array.from({ length: 1000 }, (_, index) => issue(String(index))));
    }
    assert.equal(f.all().length, 5000);
    client.push(f.docs[0].uri, []);
    client.push(f.docs[5].uri, Array.from({ length: 1000 }, (_, index) => issue(String(index))));
    assert.equal(f.all().length, 5000);
});

test('source-file diagnostic limits bound large server reports', async () => {
    const f = fixture(), client = new Client(); await f.sync(client);
    client.push(uri, Array.from({ length: 2000 }, (_, index) => issue(String(index))));
    assert.equal(f.all().length, 1000);
});
