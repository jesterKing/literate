import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LanguageClient } from '../../language-client';
import { generateProject } from '../../engine';

const server = String.raw`
const mode = process.argv[1];
let input = Buffer.alloc(0), notifications = [], replies = [], initialization;
let queue = Promise.resolve();
function send(value) {
    const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', ...value}));
    const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
    queue = queue.then(async () => {
        for (const part of [frame.subarray(0, 9), frame.subarray(9, 25), frame.subarray(25, frame.length - 2), frame.subarray(-2)]) {
            process.stdout.write(part);
            await new Promise(resolve => setImmediate(resolve));
        }
    });
}
function handle(message) {
    if (!message.method) { replies.push(message); return; }
    if (message.method === 'initialize') {
        initialization = message.params;
        send({method:'test/early', params:{ignored:true}});
        process.stderr.write('fake server stderr');
        if (mode === 'init-hang') return;
        send({id:'config', method:'workspace/configuration', params:{items:[{section:'zls'}, {section:'ts.format'}, {section:'missing'}, {}]}});
        send({id:'folders', method:'workspace/workspaceFolders'});
        send({id:'edit', method:'workspace/applyEdit', params:{edit:{}}});
        send({id:'unknown', method:'client/registerCapability', params:{registrations:[]}});
        const kind = mode.endsWith('incremental') ? 2 : 1;
        const sync = mode === 'none' ? 0 : mode.startsWith('numeric-') ? kind
            : mode.startsWith('omitted-') ? {change:kind}
            : {openClose:!mode.startsWith('no-open-close-'), change:kind};
        send({id:message.id, result:{capabilities:{positionEncoding:mode === 'utf8' ? 'utf-8' : 'utf-16',
            textDocumentSync:sync}}});
    } else if (message.method === 'events') {
        send({method:'textDocument/publishDiagnostics', params:{uri:'file:///a', version:1,
            diagnostics:[{message:'héllo 😀'}]}});
        send({id:'refresh', method:'workspace/diagnostic/refresh'});
        send({id:'not-an-event', method:'test/early', params:{ignored:true}});
        send({id:message.id, result:null});
    } else if (message.method === 'textDocument/diagnostic') {
        send({id:message.id, result:{kind:'full', resultId:'next', items:[], previous:message.params.previousResultId}});
    } else if (message.method === 'state') {
        send({id:message.id, result:{initialization, notifications, replies}});
    } else if (['textDocument/hover', 'textDocument/completion', 'completionItem/resolve',
        'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/typeDefinition',
        'textDocument/implementation', 'textDocument/references'].includes(message.method)) {
        send({id:message.id, result:{text:'héllo 😀', params:message.params}});
    } else if (message.method === '$/cancelRequest') {
        notifications.push(message);
        send({id:message.params.id, result:'late result'});
    } else if (message.method === 'block') {
        // Only cancellation produces a deliberately late response.
    } else if (message.method === 'error') {
        send({id:message.id, error:{code:-32001, message:'fake failure', data:{detail:true}}});
    } else if (message.method === 'malformed') {
        process.stdout.write('Content-Length: 1\r\n\r\n{');
    } else if (message.method === 'invalid-utf8') {
        process.stdout.write(Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n'), Buffer.from([255])]));
    } else if (message.method === 'oversize') {
        process.stdout.write('Content-Length: 8388609\r\n\r\n');
    } else if (message.method === 'header') {
        process.stdout.write('x'.repeat(8193));
    } else if (message.method === 'duplicate-length') {
        process.stdout.write('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}');
    } else if (message.method === 'crash') {
        process.exit(7);
    } else if (message.method === 'shutdown') {
        if ('params' in message) { process.exit(9); }
        if (mode !== 'shutdown-hang') send({id:message.id, result:null});
    } else if (message.method === 'exit') {
        fs = require('node:fs');
        if (mode.startsWith('marker:')) fs.writeFileSync(mode.slice(7), 'graceful');
        process.exit(0);
    } else { notifications.push(message); }
}
process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    while (true) {
        const end = input.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(input.subarray(0, end).toString())[1]);
        if (input.length < end + 4 + length) return;
        const message = JSON.parse(input.subarray(end + 4, end + 4 + length));
        input = input.subarray(end + 4 + length);
        handle(message);
    }
});
`;

function client(mode = 'full', log?: (message: string) => void): LanguageClient {
    return new LanguageClient({ command: process.execPath, args: ['-e', server, mode], cwd: process.cwd(),
        rootUri: 'file:///workspace', initializationOptions: { cache: false },
        configuration: { zls: { enable: true }, ts: { format: { indent: 2 } } }, log });
}
// The fake server's state is a test-only wire contract.
interface State {
    initialization: { capabilities: { general: { positionEncodings: string[] }; textDocument: {
        completion: { completionItem: { snippetSupport: boolean; insertReplaceSupport: boolean } } } };
        initializationOptions: unknown };
    notifications: { method: string; params: { textDocument: { uri: string; version?: number }; contentChanges?: unknown[]; id?: number } }[];
    replies: { id: string; result?: unknown; error?: { code: number } }[];
}
const state = async (connection: LanguageClient) => await connection.request('state', {}) as State;

test('language client chapter generates exactly the owned source', () => {
    const root = path.resolve(__dirname, '../../..');
    const text = fs.readFileSync(path.join(root, 'literate/language-client.literate'), 'utf8');
    for (const fragment of text.matchAll(/```ts[^\n]*\n([\s\S]*?)```/g)) {
        assert.ok(fragment[1].trimEnd().split('\n').length <= 30, 'fragments stay within 30 lines');
    }
    const generated = generateProject([{ path: 'literate/language-client.literate', text }]);
    assert.deepEqual(generated.diagnostics, []);
    assert.equal(generated.files.find(file => file.path === 'src/language-client.ts')?.content,
        fs.readFileSync(path.join(root, 'src/language-client.ts'), 'utf8'));
});

test('deduplicated initialization, split Unicode frames, server requests and document lifecycle', async t => {
    const logs: string[] = [], connection = client('full', message => logs.push(message));
    t.after(() => connection.dispose());
    assert.equal(connection.initialize(), connection.initialize());
    const doc = { uri: 'file:///workspace/one.zig', languageId: 'zig', text: '😀one' };
    await Promise.all([connection.initialize(), connection.sync([doc])]);
    await connection.sync([doc]);
    await connection.sync([{ ...doc, text: 'two' }]);
    await connection.sync([]);
    const snapshot = await state(connection);
    assert.deepEqual(snapshot.initialization.capabilities.general.positionEncodings, ['utf-16']);
    assert.deepEqual(snapshot.initialization.capabilities.textDocument, {
        synchronization: { dynamicRegistration: false },
        completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true,
            documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } } },
        signatureHelp: { contextSupport: true, signatureInformation: {
            documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
        definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true },
        references: { dynamicRegistration: false },
        publishDiagnostics: { versionSupport: true, relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        hover: { contentFormat: ['plaintext', 'markdown'] }
    });
    assert.deepEqual(snapshot.initialization.initializationOptions, { cache: false });
    assert.deepEqual(snapshot.notifications.map(item => item.method),
        ['initialized', 'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']);
    assert.equal(snapshot.notifications[1].params.textDocument.version, 1);
    assert.equal(snapshot.notifications[2].params.textDocument.version, 2);
    assert.deepEqual(snapshot.notifications[2].params.contentChanges, [{ text: 'two' }]);
    assert.deepEqual(snapshot.replies.find(item => item.id === 'config')?.result,
        [{ enable: true }, { indent: 2 }, null, { zls: { enable: true }, ts: { format: { indent: 2 } } }]);
    assert.deepEqual(snapshot.replies.find(item => item.id === 'folders')?.result,
        [{ uri: 'file:///workspace', name: path.basename(process.cwd()) }]);
    assert.deepEqual(snapshot.replies.find(item => item.id === 'edit')?.result,
        { applied: false, failureReason: 'Read-only language client' });
    assert.equal(snapshot.replies.find(item => item.id === 'unknown')?.error?.code, -32601);
    assert.match(logs.join(''), /fake server stderr/);
    for (const method of ['textDocument/hover', 'textDocument/completion', 'completionItem/resolve',
        'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/typeDefinition',
        'textDocument/implementation', 'textDocument/references']) {
        assert.deepEqual(await connection.request(method, { text: '日本😀' }), { text: 'héllo 😀', params: { text: '日本😀' } });
    }
});

test('framed notifications, refresh acknowledgement, listener isolation and generic diagnostic pull', async t => {
    const logs: string[] = [], connection = client('full', message => logs.push(message));
    t.after(() => connection.dispose());
    let early = 0, disposed = 0, refresh = 0;
    const events: unknown[] = [];
    connection.onNotification('test/early', () => early++);
    connection.onNotification('textDocument/publishDiagnostics', () => { throw new Error('secret payload'); });
    const remove = connection.onNotification('textDocument/publishDiagnostics', () => disposed++);
    connection.onNotification('textDocument/publishDiagnostics', value => events.push(value));
    connection.onNotification('workspace/diagnostic/refresh', () => {
        refresh++;
        void connection.notify('test/refreshed', {});
    });
    remove(); remove();
    await connection.notify('test/ready', { value: '😀' });
    await connection.request('events', {});
    const snapshot = await state(connection);
    assert.equal(early, 0); assert.equal(disposed, 0); assert.equal(refresh, 1);
    assert.deepEqual(events, [{ uri: 'file:///a', version: 1, diagnostics: [{ message: 'héllo 😀' }] }]);
    assert.deepEqual(snapshot.replies.find(item => item.id === 'refresh'), { jsonrpc: '2.0', id: 'refresh', result: null });
    assert.equal(snapshot.replies.find(item => item.id === 'not-an-event')?.error?.code, -32601);
    assert.ok(snapshot.notifications.some(item => item.method === 'test/refreshed'));
    assert.ok(logs.includes('Language client listener failed'));
    assert.ok(!logs.join('').includes('secret payload'));
    assert.deepEqual(await connection.request('textDocument/diagnostic', { previousResultId: 'old' }),
        { kind: 'full', resultId: 'next', items: [], previous: 'old' });
});

test('document state precedes wire writes and versions never repeat across reopen', async t => {
    const connection = client(); t.after(() => connection.dispose());
    await connection.initialize();
    const doc = { uri: 'file:///a', languageId: 'zig', text: 'one' };
    // Observe the synchronous write boundary, where a fast in-process transport could deliver diagnostics.
    const transport = connection as unknown as { send(message: { method?: string; params?: unknown }): void };
    const original = transport.send.bind(connection);
    const seen: (number | undefined)[] = [];
    transport.send = message => {
        if (message.method?.startsWith('textDocument/did')) { seen.push(connection.documentVersion(doc.uri)); }
        original(message);
    };
    assert.equal(connection.documentVersion(doc.uri), undefined);
    await connection.sync([doc]); await connection.sync([doc]);
    await connection.sync([{ ...doc, text: 'two' }]);
    await connection.sync([]); await connection.sync([doc]);
    await connection.sync([{ ...doc, languageId: 'typescript' }]);
    assert.deepEqual(seen, [1, 2, undefined, 3, undefined, 4]);
    const versions = (await state(connection)).notifications.filter(item => item.params?.textDocument?.version)
        .map(item => item.params.textDocument.version);
    assert.deepEqual(versions, [1, 2, 3, 4]);
    await connection.dispose(); assert.equal(connection.documentVersion(doc.uri), undefined);
});

test('subscriptions share a bound and stop callbacks are isolated, disposable and once-only', async t => {
    const connection = client('full', () => { throw new Error('logger failure'); });
    t.after(() => connection.dispose());
    const removers = Array.from({ length: 128 }, () => connection.onNotification('unused', () => {}));
    assert.throws(() => connection.onDidStop(() => {}), /listener limit/);
    assert.throws(() => connection.onNotification('overflow', () => {}), /listener limit/);
    removers.forEach(remove => { remove(); remove(); });
    let stops = 0, removed = 0;
    const remove = connection.onDidStop(() => removed++); remove();
    connection.onDidStop(() => { throw new Error('stop failure'); });
    connection.onDidStop(() => { stops++; assert.equal(connection.documentVersion('file:///a'), undefined); });
    await connection.sync([{ uri: 'file:///a', languageId: 'zig', text: '' }]);
    await assert.rejects(connection.request('crash', {}));
    assert.equal(stops, 1); assert.equal(removed, 0);
    await connection.dispose(); assert.equal(stops, 1);
    connection.onDidStop(() => stops++); assert.equal(stops, 2);
    const internals = connection as unknown as { listeners: Set<unknown> };
    assert.equal(internals.listeners.size, 0);
    connection.onNotification('ignored', () => {}); assert.equal(internals.listeners.size, 0);
    await assert.rejects(connection.notify('test/closed', {}));
});

test('incremental servers get full replacement UTF-16 ranges; language changes reopen', async t => {
    const connection = client('incremental'); t.after(() => connection.dispose());
    const doc = { uri: 'file:///a', languageId: 'typescript', text: 'one\r\n😀x' };
    await connection.sync([doc]);
    await connection.sync([{ ...doc, text: 'new' }]);
    await connection.sync([{ ...doc, languageId: 'zig' }]);
    const items = (await state(connection)).notifications;
    assert.deepEqual(items[2].params.contentChanges,
        [{ text: 'new', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } } }]);
    assert.deepEqual(items.slice(3).map(item => item.method), ['textDocument/didClose', 'textDocument/didOpen']);
});

test('cancellation, request errors, late responses and pending bounds leave transport usable', async t => {
    const connection = client(); t.after(() => connection.dispose());
    await connection.initialize();
    const abort = new AbortController();
    const blocked = connection.request('block', {}, abort.signal);
    await state(connection);
    abort.abort();
    await assert.rejects(blocked, { name: 'AbortError' });
    assert.ok((await state(connection)).notifications.some(item => item.method === '$/cancelRequest'));
    await assert.rejects(connection.request('block', {}, abort.signal), { name: 'AbortError' });
    await assert.rejects(connection.request('error', {}), { message: 'fake failure', code: -32001 });
    const controllers = Array.from({ length: 128 }, () => new AbortController());
    const requests = controllers.map(controller => connection.request('block', {}, controller.signal));
    const settled = Promise.allSettled(requests);
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(connection.request('block', {}), /pending request limit exceeded/);
    controllers.forEach(controller => controller.abort());
    assert.ok((await settled).every(item => item.status === 'rejected'));
    await state(connection);
});

test('document and outgoing message limits reject without corrupting the connection', async t => {
    const connection = client(); t.after(() => connection.dispose());
    const doc = { uri: 'file:///a', languageId: 'zig', text: '' };
    await assert.rejects(connection.sync([doc, doc]), /duplicate URI/);
    await assert.rejects(connection.sync([{ ...doc, text: 'x'.repeat(4 * 1024 * 1024) }]), /document set limit/);
    await assert.rejects(connection.request('textDocument/hover', { text: 'x'.repeat(8 * 1024 * 1024) }), /outgoing message limit/);
    await connection.sync([doc]);
    await state(connection);
});

test('request timeouts cancel and release pending slots', async t => {
    const connection = client(); t.after(() => connection.dispose());
    await assert.rejects(connection.request('block', {}), /timed out: block/);
    assert.ok((await state(connection)).notifications.some(item => item.method === '$/cancelRequest'));
});

for (const method of ['malformed', 'invalid-utf8', 'oversize', 'header', 'duplicate-length', 'crash']) {
    test('transport fails closed and releases pending requests: ' + method, async t => {
        const connection = client(); t.after(() => connection.dispose());
        await connection.initialize();
        const blocked = connection.request('block', {});
        const broken = connection.request(method, {});
        const results = await Promise.allSettled([blocked, broken]);
        assert.ok(results.every(item => item.status === 'rejected'));
        await assert.rejects(connection.request('state', {}));
    });
}

for (const mode of ['no-open-close-full', 'no-open-close-incremental', 'omitted-full', 'omitted-incremental']) {
    test('projections reject synchronization without open/close: ' + mode, async t => {
        const connection = client(mode); t.after(() => connection.dispose());
        await connection.initialize();
        const doc = { uri: 'file:///workspace/nonexistent.zig', languageId: 'zig', text: '😀projection' };
        await assert.rejects(connection.sync([doc]), /open\/close synchronization required/);
        await connection.sync([]);
        assert.deepEqual((await state(connection)).notifications.map(item => item.method), ['initialized']);
    });
}

for (const mode of ['numeric-full', 'numeric-incremental']) {
    test('legacy numeric synchronization implies open/close: ' + mode, async t => {
        const connection = client(mode); t.after(() => connection.dispose());
        await connection.initialize();
        assert.equal(connection.capabilities.textDocumentSync, mode === 'numeric-full' ? 1 : 2);
        const doc = { uri: 'file:///workspace/nonexistent.zig', languageId: 'zig', text: '😀projection' };
        await connection.sync([doc]);
        await connection.sync([{ ...doc, text: 'changed' }]);
        await connection.sync([]);
        const items = (await state(connection)).notifications;
        assert.deepEqual(items.map(item => item.method),
            ['initialized', 'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']);
        assert.deepEqual(items[1].params.textDocument, { ...doc, version: 1 });
        assert.equal(items[2].params.textDocument.version, 2);
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: doc.text.length } };
        assert.deepEqual(items[2].params.contentChanges,
            [{ text: 'changed', ...(mode === 'numeric-incremental' ? { range } : {}) }]);
    });
}

test('unsupported synchronization and position encoding are explicit errors', async t => {
    const none = client('none'), utf8 = client('utf8');
    t.after(async () => { await none.dispose(); await utf8.dispose(); });
    await assert.rejects(none.sync([{ uri: 'file:///a', languageId: 'zig', text: '' }]), /synchronization unsupported/);
    await assert.rejects(utf8.initialize(), /UTF-16/);
});

test('spawn failures, disposal during initialization, and cancellation before readiness', async () => {
    const missing = new LanguageClient({ command: '/literate-nonexistent-command', cwd: process.cwd(), rootUri: 'file:///a' });
    await assert.rejects(missing.initialize(), /ENOENT/); await missing.dispose();
    const connection = client('init-hang');
    const abort = new AbortController();
    const request = connection.request('state', {}, abort.signal);
    abort.abort(); await assert.rejects(request, { name: 'AbortError' });
    const ready = connection.initialize();
    const rejected = assert.rejects(ready, /disposed/);
    await connection.dispose(); await rejected;
    await assert.rejects(connection.initialize(), /disposed/);
});

test('shutdown omits params, exits gracefully, and forced shutdown is bounded', async t => {
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'literate-client-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const marker = path.join(directory, 'exit'), graceful = client('marker:' + marker);
    t.after(() => graceful.dispose());
    await graceful.initialize();
    let stops = 0;
    graceful.onDidStop(() => stops++);
    assert.equal(graceful.dispose(), graceful.dispose());
    await graceful.dispose();
    assert.equal(fs.readFileSync(marker, 'utf8'), 'graceful');
    assert.equal(stops, 1);
    const stalled = client('shutdown-hang'); t.after(() => stalled.dispose());
    await stalled.initialize();
    const start = Date.now(); await stalled.dispose();
    assert.ok(Date.now() - start < 2500);
});
