/* VS Code mocks use the public API's spelling. The chapter is loaded in memory:
 * these tests neither generate files nor depend on activation/index integration. */
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-explicit-any */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as ts from 'typescript';

const project = path.resolve(__dirname, '../../..');
const sizes = ['.git', 'node_modules', 'out', 'dist', '.yarn', '.vscode-test'];
const uri = (fsPath: string, scheme = 'file') => ({ fsPath, scheme, authority: '', toString: () => `${scheme}:${fsPath}` });

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'literate-publication-ui-'));
    const folder = { name: 'Project', uri: uri(root), index: 0 };
    const handlers = new Map<string, () => Promise<void>>();
    const state = new Map<string, any>();
    const errors: string[] = [], logs: string[] = [], warnings: string[] = [];
    const opened: any[] = [], requests: any[] = [], prompts: any[] = [];
    const disposables: any[] = [];
    const settings: Record<string, any> = { nodePath: '/usr/bin/node' };
    const changes = new EventEmitter();
    const token = { isCancellationRequested: false, onCancellationRequested(callback: () => void) {
        changes.on('cancel', callback); return { dispose() { changes.off('cancel', callback); } };
    } };
    const f: any = { root, folder, handlers, state, errors, logs, warnings, opened, requests, prompts, settings, token,
        cancelStage: '', paper: 'a4', margins: '20,20,20,20', save: uri(path.join(root, 'book.tex')),
        onProgress: undefined, onSave: undefined, onSnapshotRead: undefined, bridgeFailure: undefined,
        bridgeHook: undefined, reply: undefined, child: undefined, spawned: [], channels: [], sources: [], infos: [] };
    const folderEvents = new EventEmitter();
    class CancellationTokenSource {
        private readonly events = new EventEmitter();
        disposed = false;
        readonly token = { isCancellationRequested: false, onCancellationRequested: (callback: () => void) => {
            this.events.on('cancel', callback);
            return { dispose: () => { this.events.off('cancel', callback); } };
        } };
        constructor() { f.sources.push(this); }
        cancel(): void {
            if (this.disposed || this.token.isCancellationRequested) { return; }
            this.token.isCancellationRequested = true;
            this.events.emit('cancel');
        }
        dispose(): void { this.disposed = true; this.events.removeAllListeners(); }
    }
    const workspace: any = { isTrusted: true, workspaceFolders: [folder], textDocuments: [],
        onDidChangeWorkspaceFolders(callback: (event: any) => void) {
            folderEvents.on('change', callback);
            return { dispose() { folderEvents.off('change', callback); } };
        },
        getWorkspaceFolder: (value: any) => workspace.workspaceFolders.find((item: any) =>
            value.scheme === item.uri.scheme && (value.fsPath === item.uri.fsPath || value.fsPath.startsWith(item.uri.fsPath + '/'))),
        getConfiguration: () => ({ inspect: (name: string) => ({ globalValue: settings[name], workspaceValue: f.workspaceNode }),
            get: (name: string) => settings[name] }) };
    const vscode: any = { workspace, CancellationTokenSource, env: {}, UIKind: { Web: 2 }, Uri: { file: uri }, ProgressLocation: { Notification: 15 },
        commands: { registerCommand(name: string, callback: () => Promise<void>) {
            handlers.set(name, callback); return { dispose() { handlers.delete(name); } };
        }, async executeCommand(...args: any[]) { opened.push(args); } },
        window: { activeTextEditor: undefined,
            createOutputChannel: () => {
                const channel = { disposed: false, disposeCount: 0,
                    appendLine(line: string) { assert.equal(this.disposed, false, 'channel must remain live for results'); logs.push(line); },
                    show() { assert.equal(this.disposed, false); },
                    dispose() { this.disposed = true; this.disposeCount++; }
                };
                f.channels.push(channel); return channel;
            },
            async showQuickPick(items: any[], options: any) {
                const stage = typeof items[0] === 'string' ? 'paper' : 'folder';
                prompts.push({ stage, items, options });
                if (f.cancelStage === stage) { return undefined; }
                return stage === 'paper' ? f.paper : items[f.folderIndex ?? 0];
            },
            async showInputBox(options: any) {
                prompts.push({ stage: 'margins', options });
                return f.cancelStage === 'margins' ? undefined : f.margins;
            },
            async showSaveDialog(options: any) {
                prompts.push({ stage: 'save', options });
                f.onSave?.();
                return f.cancelStage === 'save' ? undefined : f.save;
            },
            async withProgress(_options: any, callback: any) {
                f.onProgress?.();
                return callback({ report: (value: any) => logs.push(value.message) }, token);
            },
            async showErrorMessage(value: string) { errors.push(value); await f.onError?.(); },
            async showWarningMessage(value: string) { warnings.push(value); },
            async showInformationMessage(...args: any[]) { f.infos.push(args); await f.onInfo?.(); return 'Open Output'; }
        } };
    const context = { subscriptions: disposables, asAbsolutePath: (name: string) => path.join(project, name),
        workspaceState: { get: (key: string) => state.get(key), async update(key: string, value: any) {
                    state.set(key, value); await f.onRemember?.();
                } } };
    const chapter = await fs.readFile(path.join(project, 'literate/publication-extension.literate'), 'utf8');
    const fragments = [...chapter.matchAll(/```typescript: <<publication extension (?!\*>>)([^>]+)>>=\+?\n([\s\S]*?)\n```/g)];
    assert.ok(fragments.length > 8);
    const source = fragments.map(match => match[2]).join('\n');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } });
    const exports: any = {};
    const injectedRequire = (name: string): any => {
        if (name === 'vscode') { return vscode; }
        if (name === './engine') {
            // Use the actual engine in both source-run and compiled test environments.
            return require('../../engine');
        }
        if (name === 'node:fs/promises') { return { ...fs, async readdir(...args: any[]) {
            f.onSnapshotRead?.();
            return (fs.readdir as any)(...args);
        } }; }
        if (name === 'node:child_process') { return { spawn(...args: any[]) {
            f.spawned.push(args);
            if (f.spawnError) { throw f.spawnError; }
            assert.ok(f.child, 'process bridge tests must provide a child');
            f.onSpawn?.();
            return f.child;
        } }; }
        return require(name);
    };
    const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
    f.timers = timers;
    const schedule = (callback: () => void, delay: number) => {
        if (!f.fakeTimers) { return setTimeout(callback, delay); }
        const timer = { callback, delay, cleared: false }; timers.push(timer); return timer;
    };
    const unschedule = (timer: any) => {
        if (timers.includes(timer)) { timer.cleared = true; } else { clearTimeout(timer); }
    };
    const runtime = Object.create(process);
    Object.defineProperty(runtime, 'platform', { get: () => f.platform ?? process.platform });
    new Function('require', 'exports', 'setTimeout', 'clearTimeout', 'process', compiled.outputText)
        (injectedRequire, exports, schedule, unschedule, runtime);
    const bridge = async (...args: any[]) => {
        requests.push(args);
        if (f.realBridge) { return exports.runPublicationHelper(...args); }
        await f.bridgeHook?.(...args);
        if (f.bridgeFailure) { throw new Error(f.bridgeFailure); }
        const request = args[3];
        return f.reply ?? { stdout: JSON.stringify({ schemaVersion: 1, command: request.args[0], ok: true,
            outputs: [{ path: request.args[request.args.indexOf('--output') + 1], status: 'written' }],
            publication: { warnings: ['fixture warning'] }, elapsedMs: 65423 }), stderr: '' };
    };
    exports.registerPublicationCommands(context, undefined, bridge);
    Object.assign(f, { vscode, workspace, context, api: exports,
        register: (serialize: <T>(operation: () => Promise<T>) => Promise<T>) => {
            f.disposeRegistration();
            exports.registerPublicationCommands(context, serialize, bridge);
        },
        folderEvents, progressEvents: changes,
        removeFolder(removed = folder) {
            workspace.workspaceFolders = workspace.workspaceFolders.filter((item: any) => item !== removed);
            folderEvents.emit('change', { removed: [removed], added: [] });
        },
        disposeRegistration() { for (const value of disposables) { value.dispose(); } },
        run: (kind = 'latex') => handlers.get(kind === 'latex' ? 'literate.exportLatex' : 'literate.exportPdf')!(),
        cancel() { token.isCancellationRequested = true; changes.emit('cancel'); },
        document(name: string, text: string, scheme = 'file') { return { uri: uri(path.join(root, name), scheme), getText: () => text }; },
        async put(name: string, text: string) {
            await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
            await fs.writeFile(path.join(root, name), text);
        },
        async dispose() { f.disposeRegistration(); await fs.rm(root, { recursive: true, force: true }); }
    });
    return f;
}

async function using(callback: (f: any) => Promise<void>): Promise<void> {
    const f = await fixture();
    try { await callback(f); } finally { await f.dispose(); }
}

for (const stage of ['folder', 'paper', 'margins', 'save']) {
    test(`publication cancellation at ${stage} neither launches nor remembers nor writes`, () => using(async f => {
        f.cancelStage = stage;
        await f.run();
        assert.equal(f.requests.length, 0);
        assert.equal(f.state.size, 0);
        assert.deepEqual(f.errors, []);
        assert.deepEqual(await fs.readdir(f.root), []);
        assert.deepEqual(f.opened, []);
    }));
}

for (const policy of ['trust', 'remote', 'web', 'windows', 'scheme', 'removed', 'late-trust', 'late-removed']) {
    test(`publication rejects ${policy}`, () => using(async f => {
        if (policy === 'trust') { f.workspace.isTrusted = false; }
        if (policy === 'remote') { f.vscode.env.remoteName = 'ssh-remote'; }
        if (policy === 'web') { f.vscode.env.uiKind = 2; }
        if (policy === 'windows') { f.platform = 'win32'; }
        if (policy === 'scheme') { f.folder.uri = uri(f.root, 'memfs'); }
        if (policy === 'removed') { f.onSave = () => { f.workspace.workspaceFolders = []; }; }
        if (policy === 'late-trust') { f.onSnapshotRead = () => { f.workspace.isTrusted = false; }; }
        if (policy === 'late-removed') { f.onSnapshotRead = () => { f.workspace.workspaceFolders = []; }; }
        await f.run();
        assert.equal(f.requests.length, 0);
        assert.equal(f.state.size, 0);
        assert.equal(f.errors.length, 1);
        assert.deepEqual(f.opened, []);
    }));
}

test('active editor selects its root; fresh sorted snapshots preserve empty/new captured buffers', () => using(async f => {
    f.vscode.window.activeTextEditor = { document: f.document('index.literate', '') };
    await f.put('index.literate', 'disk index');
    await f.put('z.literate', 'disk z');
    await f.put('empty.literate', 'must disappear');
    await f.put('asset.png', 'disk asset');
    for (const name of sizes) { await f.put(`nested/${name}/ignored.literate`, 'ignored'); }
    const index = f.document('index.literate', 'captured');
    f.workspace.textDocuments = [index, f.document('empty.literate', ''), f.document('new.literate', 'new'),
        f.document('untitled.literate', 'ignored', 'untitled'), f.document('asset.png', 'ignored'),
        { uri: uri(path.join(f.root, '../foreign.literate')), getText: () => 'ignored' },
        ...sizes.map(name => f.document(`${name}/new.literate`, 'ignored'))];
    f.onSnapshotRead = () => { index.getText = () => 'edited during disk discovery'; };
    await f.run();
    assert.deepEqual(f.errors, []);
    assert.equal(f.prompts[0].stage, 'paper');
    assert.deepEqual(f.requests[0][3].documents, [
        { path: 'empty.literate', text: '' }, { path: 'index.literate', text: 'captured' },
        { path: 'new.literate', text: 'new' }, { path: 'z.literate', text: 'disk z' }
    ]);
    await f.put('z.literate', 'fresh second disk');
    f.onSnapshotRead = undefined;
    await f.run();
    assert.equal(f.requests[1][3].documents.find((d: any) => d.path === 'z.literate').text, 'fresh second disk');
    assert.equal(f.requests[1][3].documents.find((d: any) => d.path === 'index.literate').text, 'edited during disk discovery');
    assert.equal(await fs.readFile(path.join(f.root, 'empty.literate'), 'utf8'), 'must disappear');
}));

test('folder picker selects a nonactive workspace', () => using(async f => {
    const other = path.join(f.root, 'other');
    await fs.mkdir(other);
    f.workspace.workspaceFolders.push({ name: 'Other', uri: uri(other), index: 1 });
    f.folderIndex = 1;
    f.save = uri(path.join(other, 'book.tex'));
    await f.run();
    assert.deepEqual(f.errors, []);
    assert.equal(f.requests[0][2], other);
}));

for (const mode of ['disk', 'buffer', 'ancestor', 'dangling', 'destination']) {
    test(`symlink ${mode} is ignored on disk or rejected for buffers/output`, () => using(async f => {
        await f.put('real.literate', 'real');
        const target = mode === 'ancestor' ? f.root : path.join(f.root, mode === 'dangling' ? 'missing' : 'real.literate');
        await fs.symlink(target, path.join(f.root, 'link.literate'));
        if (mode === 'destination') { f.save = uri(path.join(f.root, 'link.tex')); await fs.symlink(target, f.save.fsPath); }
        else if (mode !== 'disk') { f.workspace.textDocuments = [f.document(mode === 'ancestor' ? 'link.literate/new.literate' : 'link.literate', 'buffer')]; }
        await f.run();
        if (mode === 'disk') {
            assert.deepEqual(f.errors, []);
            assert.deepEqual(f.requests[0][3].documents, [{ path: 'real.literate', text: 'real' }]);
        } else { assert.equal(f.requests.length, 0); assert.match(f.errors[0], /Unsafe/); }
    }));
}

test('geometry validator enforces order, decimal mm, range and minimum body', () => using(async f => {
    for (const value of ['20,20,20', '20,20,20,', 'NaN,20,20,20', '4,20,20,20', '51,20,20,20', '20mm,20,20,20', '1e1,20,20,20']) {
        assert.ok(f.api.validateMargins('a4', value), value);
    }
    assert.ok(f.api.validateMargins('a5', '20,35,20,35'));
    assert.equal(f.api.validateMargins('a5', '20,34,20,34'), undefined);
    assert.equal(f.api.validateMargins('letter', '5.5,6,7,8'), undefined);
    f.margins = '20,35,20,35'; f.paper = 'a5';
    await f.run();
    assert.equal(f.requests.length, 0);
}));

for (const destination of ['outside', 'extension', 'scheme', 'directory']) {
    test(`save dialog cannot authorize ${destination} output`, () => using(async f => {
        if (destination === 'outside') { f.save = uri(path.join(f.root, '../escape.tex')); }
        if (destination === 'extension') { f.save = uri(path.join(f.root, 'book.pdf')); }
        if (destination === 'scheme') { f.save = uri(path.join(f.root, 'book.tex'), 'memfs'); }
        if (destination === 'directory') { await fs.mkdir(f.save.fsPath); }
        await f.run();
        assert.equal(f.requests.length, 0);
        assert.equal(f.state.size, 0);
        assert.equal(f.errors.length, 1);
    }));
}

for (const setting of ['missing-node', 'relative-node', 'workspace-node', 'relative-browser', 'manifest-escape']) {
    test(`explicit dependency settings reject ${setting}`, () => using(async f => {
        if (setting === 'missing-node' || setting === 'workspace-node') { delete f.settings.nodePath; }
        if (setting === 'workspace-node') { f.workspaceNode = '/project/untrusted-node'; }
        if (setting === 'relative-node') { f.settings.nodePath = './node'; }
        if (setting === 'relative-browser') { f.settings.browserPath = 'chromium'; }
        if (setting === 'manifest-escape') { f.settings.fontManifest = '../manifest.json'; }
        await f.run();
        assert.equal(f.requests.length, 0);
        assert.equal(f.errors.length, 1);
        assert.equal(f.state.size, 0);
    }));
}

test('PDF request arguments, disk fonts, warning channel, open URI and successful per-kind memory', () => using(async f => {
    f.save = uri(path.join(f.root, 'book.pdf'));
    f.paper = 'legal'; f.margins = '10, 11,12,13';
    f.settings.browserPath = '/opt/chromium'; f.settings.fontManifest = 'fonts.json';
    await f.put('fonts.json', '{"disk":true}');
    f.workspace.textDocuments = [f.document('fonts.json', 'not a source')];
    await f.run('pdf');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.requests[0].slice(0, 3), ['/usr/bin/node', path.join(project, 'out/publication-helper.cjs'), f.root]);
    assert.deepEqual(f.requests[0][3], { args: ['pdf', f.root, '--output', 'book.pdf', '--paper', 'legal',
        '--margin-top', '10mm', '--margin-outer', '11mm', '--margin-bottom', '12mm', '--margin-inner', '13mm',
        '--browser', '/opt/chromium', '--font-manifest', 'fonts.json', '--json'], documents: [] });
    assert.ok(f.logs.some((line: string) => line.includes('fixture warning')));
    assert.equal(f.logs[f.logs.length - 1], 'Publication finished in 01:05');
    assert.equal(f.opened[0][0], 'vscode.open');
    assert.equal(f.opened[0][1].fsPath, f.save.fsPath);
    assert.deepEqual([...f.state.values()], [{ paper: 'legal', margins: '10,11,12,13', destination: 'book.pdf' }]);
    f.prompts.length = 0;
    await f.run('pdf');
    assert.equal(f.prompts.find((p: any) => p.stage === 'paper').items[0], 'legal');
    assert.equal(f.prompts.find((p: any) => p.stage === 'margins').options.value, '10,11,12,13');
    f.prompts.length = 0; f.cancelStage = 'margins';
    await f.run();
    assert.equal(f.prompts.find((p: any) => p.stage === 'margins').options.value, '20,20,20,20');
    assert.equal(f.state.size, 1);
}));

for (const failure of ['dependency', 'json', 'ok-false', 'empty-output', 'wrong-output', 'wrong-status']) {
    test(`failed ${failure} never remembers or offers open`, () => using(async f => {
        if (failure === 'dependency') { f.bridgeFailure = 'Missing Pandoc: install pandoc'; }
        else {
            const response: any = { schemaVersion: 1, command: 'latex', ok: true, outputs: [{ path: 'book.tex', status: 'written' }] };
            if (failure === 'ok-false') { response.ok = false; response.errors = ['missing latexmk']; }
            if (failure === 'empty-output') { response.outputs = []; }
            if (failure === 'wrong-output') { response.outputs[0].path = 'elsewhere.tex'; }
            if (failure === 'wrong-status') { response.outputs[0].status = 'stale'; }
            f.reply = { stdout: failure === 'json' ? 'bad json' : JSON.stringify(response), stderr: 'useful stderr' };
        }
        await f.run();
        assert.equal(f.state.size, 0);
        assert.deepEqual(f.opened, []);
        assert.equal(f.errors.length, 1);
        assert.ok(f.logs.length);
    }));
}

test('only successful choices replace memory and current outputs count as success', () => using(async f => {
    await f.run();
    const before = JSON.stringify([...f.state]);
    f.paper = 'letter'; f.bridgeFailure = 'dependency failed';
    await f.run();
    assert.equal(JSON.stringify([...f.state]), before);
    f.bridgeFailure = undefined;
    f.reply = { stdout: JSON.stringify({ schemaVersion: 1, command: 'latex', ok: true,
        outputs: [{ path: 'book.tex', status: 'current' }] }), stderr: '' };
    await f.run();
    assert.equal([...f.state.values()][0].paper, 'letter');
}));

test('pre-cancelled progress avoids snapshot and launch; cancellation during build prevents success UI', () => using(async f => {
    f.onProgress = () => f.cancel();
    await f.run();
    assert.equal(f.requests.length, 0);
    f.token.isCancellationRequested = false; f.onProgress = undefined;
    f.bridgeHook = () => f.cancel();
    f.reply = { stdout: JSON.stringify({ schemaVersion: 1, command: 'latex', ok: false,
        outputs: [], errors: ['Publication cancelled during compilation'] }), stderr: '' };
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.size, 0);
    assert.deepEqual(f.opened, []);
}));

test('success notification does not retain the publication lock', () => using(async f => {
    const entered = deferred(), release = deferred();
    let notifications = 0;
    f.onInfo = () => {
        notifications++;
        if (notifications === 1) { entered.resolve(); return release.promise; }
        return undefined;
    };
    const first = f.run();
    await entered.promise;
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.warnings, []);
    release.resolve();
    await first;
}));

test('failure notification does not retain the publication lock', () => using(async f => {
    const entered = deferred(), release = deferred();
    f.bridgeFailure = 'fixture failure';
    f.onError = () => { entered.resolve(); return release.promise; };
    await f.run();
    await entered.promise;
    f.bridgeFailure = undefined;
    await f.run();
    assert.equal(f.requests.length, 2);
    release.resolve();
}));

test('global command lock rejects overlap across kinds until helper finishes', () => using(async f => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.bridgeHook = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    const first = f.run();
    await entered;
    await f.run('pdf');
    assert.equal(f.requests.length, 1);
    assert.equal(f.warnings.length, 1);
    release(); await first;
    f.bridgeHook = undefined;
    await f.run();
    assert.equal(f.requests.length, 2);
}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function operationQueue() {
    let processing = Promise.resolve();
    const failures: unknown[] = [];
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = processing.then(operation);
        processing = result.then(() => {}, error => { failures.push(error); });
        return result;
    };
    return { serialize, failures };
}

test('cancellation while queued skips captured buffers, disk discovery and helper launch', () => using(async f => {
    const queue = operationQueue(), release = deferred(), enqueued = deferred();
    let progressStarted = false, captures = 0;
    f.onProgress = () => { progressStarted = true; };
    f.onSnapshotRead = () => { captures++; };
    f.workspace.textDocuments = [{ uri: uri(path.join(f.root, 'index.literate')), getText() {
        captures++; return 'buffer';
    } }];
    const generation = queue.serialize(() => release.promise);
    f.register(<T>(operation: () => Promise<T>): Promise<T> => {
        assert.equal(progressStarted, true, 'queue waiting belongs inside cancellable progress');
        enqueued.resolve();
        return queue.serialize(operation);
    });
    const publication = f.run();
    await enqueued.promise;
    assert.equal(captures, 0);
    assert.equal(f.requests.length, 0);
    await f.run('pdf');
    assert.equal(f.warnings.length, 1, 'duplicate publication is rejected even while queued');
    f.cancel();
    release.resolve();
    await generation;
    await publication;
    assert.equal(captures, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.size, 0);
    assert.deepEqual(f.opened, []);
    assert.match(f.errors[0], /cancelled/);
    assert.match(String(queue.failures[0]), /cancelled/);
    assert.equal(await queue.serialize(async () => 'generation after cancellation'), 'generation after cancellation');
    f.token.isCancellationRequested = false;
    await f.run();
    assert.equal(f.requests.length, 1, 'command guard is released after queued cancellation');
}));

for (const fails of [false, true]) {
    test(`shared queue delays source capture and later generation through helper ${fails ? 'failure' : 'success'}`, () => using(async f => {
        const queue = operationQueue(), releaseGeneration = deferred(), enqueued = deferred();
        const helperStarted = deferred(), releaseHelper = deferred();
        const events: string[] = [];
        f.register(<T>(operation: () => Promise<T>): Promise<T> => {
            enqueued.resolve(); return queue.serialize(operation);
        });
        const earlierGeneration = queue.serialize(async () => {
            await releaseGeneration.promise;
            await f.put('index.literate', 'after generation');
            events.push('earlier generation');
        });
        f.onSnapshotRead = () => events.push('snapshot');
        f.bridgeFailure = fails ? 'helper operation failed' : undefined;
        f.bridgeHook = async () => {
            events.push('helper start'); helperStarted.resolve();
            await releaseHelper.promise;
            events.push('helper cleanup');
        };
        const publication = f.run();
        await enqueued.promise;
        assert.equal(events.length, 0);
        releaseGeneration.resolve();
        await earlierGeneration;
        await helperStarted.promise;
        assert.deepEqual(f.requests[0][3].documents, [{ path: 'index.literate', text: 'after generation' }]);
        const laterGeneration = queue.serialize(async () => { events.push('later generation'); return 42; });
        await Promise.resolve();
        assert.deepEqual(events, ['earlier generation', 'snapshot', 'helper start']);
        releaseHelper.resolve();
        await publication;
        assert.equal(await laterGeneration, 42);
        assert.deepEqual(events, ['earlier generation', 'snapshot', 'helper start', 'helper cleanup', 'later generation']);
        assert.equal(queue.failures.length, fails ? 1 : 0);
        assert.equal(f.state.size, fails ? 0 : 1);
        if (fails) {
            assert.match(String(queue.failures[0]), /helper operation failed/);
            assert.match(f.errors[0], /helper operation failed/);
            assert.deepEqual(f.opened, []);
            f.bridgeFailure = undefined;
            await f.run();
            assert.equal(f.requests.length, 2, 'operation failure releases the command guard');
        } else { assert.deepEqual(f.errors, []); }
    }));
}

function fakeChild() {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.signals = [];
    child.kill = (signal: string) => { child.signals.push(signal); return true; };
    return child;
}
const envelope = { args: ['latex', '/project', '--output', 'book.tex', '--json'], documents: [] };

for (const scenario of ['success', 'exit', 'signal', 'spawn-error', 'stdin-error', 'cap', 'cancel']) {
    test(`process bridge ${scenario} waits for close, uses no shell and disposes cancellation`, () => using(async f => {
        const child = fakeChild(); f.child = child;
        let input = ''; child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
        let settled = false;
        const running = f.api.runPublicationHelper('/opt/node', '/extension/out/publication-helper.cjs', f.root,
            envelope, f.token, (line: string) => f.logs.push(line));
        const checked = running.then((value: any) => { settled = true; return value; }, (error: Error) => { settled = true; throw error; });
        const rejected = scenario !== 'success' ? assert.rejects(checked) : undefined;
        assert.deepEqual(f.spawned[0], ['/opt/node', ['/extension/out/publication-helper.cjs'],
            { cwd: f.root, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }]);
        assert.deepEqual(JSON.parse(input), envelope);
        if (scenario === 'cancel') { f.cancel(); assert.deepEqual(child.signals, ['SIGTERM']); }
        if (scenario === 'cap') {
            child.stdout.write(Buffer.alloc(4 * 1024 * 1024)); child.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1));
            assert.deepEqual(child.signals, ['SIGTERM']);
        }
        if (scenario === 'spawn-error') { child.emit('error', new Error('ENOENT')); }
        if (scenario === 'stdin-error') { child.stdin.emit('error', new Error('EPIPE')); }
        child.emit('exit', scenario === 'exit' ? 1 : 0, scenario === 'signal' ? 'SIGTERM' : null);
        await Promise.resolve(); assert.equal(settled, false, 'exit is not stdio/cleanup completion');
        const stdout = JSON.stringify({ schemaVersion: 1, command: 'latex', ok: true,
            outputs: [{ path: 'book.tex', status: 'written' }], publication: { warnings: ['é'] } });
        if (scenario === 'success') {
            const bytes = Buffer.from(stdout), split = bytes.indexOf(Buffer.from('é')) + 1;
            child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split));
            child.stderr.write('warning');
        }
        child.emit('close', scenario === 'exit' ? 1 : 0, scenario === 'signal' ? 'SIGTERM' : null);
        if (rejected) { await rejected; }
        else { assert.deepEqual(await checked, { stdout, stderr: 'warning' }); }
        const signals = child.signals.length; f.cancel(); assert.equal(child.signals.length, signals);
    }));
}

test('deadline requests graceful termination, reports stalled cleanup and never force-kills', () => using(async f => {
    f.fakeTimers = true;
    f.child = fakeChild();
    let settled = false;
    const running = f.api.runPublicationHelper('/node', '/helper', f.root, envelope, f.token,
        (line: string) => f.logs.push(line));
    const checked = assert.rejects(running, /10 minute/).then(() => { settled = true; });
    assert.equal(f.timers[0].delay, 600000);
    f.timers[0].callback();
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.equal(f.timers[1].delay, 30000);
    f.timers[1].callback();
    assert.match(f.logs[0], /not acknowledged cancellation/);
    assert.match(f.logs[0], /remains locked/);
    await Promise.resolve();
    assert.equal(settled, false);
    f.cancel();
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    f.child.stdout.write(JSON.stringify({ ok: false, errors: ['cancelled'], outputs: [] }));
    f.child.emit('close', 1, null);
    await checked;
    assert.ok(f.timers.every((timer: any) => timer.cleared));
}));

test('symlink root is rejected before source capture', () => using(async f => {
    const link = path.join(f.root, 'alias');
    await fs.symlink(f.root, link);
    f.folder.uri = uri(link);
    await f.run();
    assert.equal(f.requests.length, 0);
    assert.match(f.errors[0], /canonical directory/);
}));

function committedResponse(status = 'written'): string {
    return JSON.stringify({ schemaVersion: 1, command: 'latex', ok: true,
        outputs: [{ path: 'book.tex', status }], publication: { warnings: [] } });
}

for (const outcome of ['written', 'current', 'cancelled']) {
    test(`helper ${outcome} outcome is authoritative after progress cancellation and close`, () => using(async f => {
        const queue = operationQueue(), spawned = deferred();
        f.register(queue.serialize);
        f.realBridge = true; f.child = fakeChild(); f.onSpawn = spawned.resolve;
        const publication = f.run();
        await spawned.promise;
        const operationToken = f.requests[0][4];
        assert.notEqual(operationToken, f.token, 'helper receives an operation-owned token');
        f.cancel();
        assert.equal(operationToken.isCancellationRequested, true);
        assert.deepEqual(f.child.signals, ['SIGTERM']);
        let generated = false;
        const laterGeneration = queue.serialize(async () => { generated = true; });
        f.child.stdout.write(outcome === 'cancelled' ? JSON.stringify({ schemaVersion: 1, command: 'latex', ok: false,
            outputs: [], errors: ['Publication cancelled during compilation'] }) : committedResponse(outcome));
        const code = outcome === 'cancelled' ? 1 : 0;
        f.child.emit('exit', code, null);
        await Promise.resolve();
        assert.equal(generated, false);
        assert.equal(f.state.size, 0);
        assert.equal(f.infos.length, 0);
        f.child.emit('close', code, null);
        await publication; await laterGeneration;
        if (outcome === 'cancelled') {
            assert.equal(f.state.size, 0);
            assert.equal(f.opened.length, 0);
            assert.match(f.errors[0], /cancelled during compilation/);
        } else {
            assert.deepEqual(f.errors, []);
            assert.equal(f.state.size, 1);
            assert.equal(f.infos.length, 1);
            assert.equal(f.opened.length, 1);
            assert.equal([...f.state.values()][0].destination, 'book.tex');
        }
        assert.equal(f.sources[0].disposed, true);
        assert.equal(f.progressEvents.listenerCount('cancel'), 0);
    }));
}

for (const revocation of ['removal', 'disposal']) {
    for (const committed of [false, true]) {
        test(`${revocation} cancels active helper, holds queue through close and handles ${committed ? 'commit' : 'cancellation'}`, () => using(async f => {
            const queue = operationQueue(), spawned = deferred();
            f.register(queue.serialize);
            f.realBridge = true; f.child = fakeChild(); f.onSpawn = spawned.resolve;
            const savedCommand = f.handlers.get('literate.exportLatex');
            const publication = f.run();
            await spawned.promise;
            const channel = f.channels[f.channels.length - 1];
            if (revocation === 'removal') {
                f.removeFolder();
                f.workspace.workspaceFolders.push(f.folder);
                f.folderEvents.emit('change', { removed: [], added: [f.folder] });
            } else { f.disposeRegistration(); f.disposeRegistration(); }
            assert.equal(f.requests[0][4].isCancellationRequested, true);
            assert.deepEqual(f.child.signals, ['SIGTERM']);
            assert.equal(channel.disposed, false, 'result channel stays alive during helper cleanup');
            let generated = false;
            const later = queue.serialize(async () => { generated = true; });
            f.child.stdout.write(committed ? committedResponse() : JSON.stringify({ schemaVersion: 1, command: 'latex',
                ok: false, outputs: [], errors: ['Publication cancelled'] }));
            f.child.emit('exit', committed ? 0 : 1, null);
            await Promise.resolve();
            assert.equal(generated, false);
            assert.equal(channel.disposed, false);
            if (revocation === 'removal') {
                await f.run('pdf'); assert.equal(f.warnings.length, 1, 'global guard still held');
            } else {
                await savedCommand(); assert.equal(f.requests.length, 1, 'disposed command cannot restart');
                assert.equal(f.handlers.size, 0);
                assert.equal(f.folderEvents.listenerCount('change'), 0);
            }
            f.child.emit('close', committed ? 0 : 1, null);
            await publication; await later;
            assert.equal(f.state.size, 0);
            assert.equal(f.infos.length, 0);
            assert.equal(f.opened.length, 0);
            assert.equal(f.sources[0].disposed, true);
            assert.equal(f.progressEvents.listenerCount('cancel'), 0);
            if (committed) {
                assert.deepEqual(f.errors, []);
                assert.ok(f.logs.some((line: string) => line.includes(`Publication completed: ${f.root}/book.tex`)));
                assert.ok(f.logs.some((line: string) => line.includes('No further success actions')));
                assert.ok(!f.logs.some((line: string) => line.includes('Publication failed')));
            } else { assert.ok(f.logs.some((line: string) => line.includes('Publication failed'))); }
            assert.equal(channel.disposed, revocation === 'disposal');
            if (revocation === 'disposal') { assert.equal(channel.disposeCount, 1); }
        }));
    }
}

for (const revocation of ['removal', 'disposal']) {
    test(`${revocation} while queued skips snapshot and spawn without releasing queue early`, () => using(async f => {
        const queue = operationQueue(), release = deferred(), enqueued = deferred();
        const earlier = queue.serialize(() => release.promise);
        let captures = 0, settled = false;
        f.onSnapshotRead = () => { captures++; };
        f.register(<T>(operation: () => Promise<T>): Promise<T> => {
            enqueued.resolve(); return queue.serialize(operation);
        });
        const publication = f.run().then(() => { settled = true; });
        await enqueued.promise;
        if (revocation === 'removal') { f.removeFolder(); } else { f.disposeRegistration(); }
        assert.equal(f.sources[0].token.isCancellationRequested, true);
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(f.channels[f.channels.length - 1].disposed, false);
        release.resolve();
        await earlier; await publication;
        assert.equal(captures, 0);
        assert.equal(f.requests.length, 0);
        assert.equal(f.state.size, 0);
        assert.equal(f.opened.length, 0);
        assert.equal(f.sources[0].disposed, true);
    }));
}

test('disposal during prompts prevents snapshot/spawn and disposes the channel only after command settles', () => using(async f => {
    let captures = 0;
    f.onSnapshotRead = () => { captures++; };
    f.onSave = () => {
        f.disposeRegistration();
        assert.equal(f.channels[0].disposed, false);
    };
    await f.run();
    assert.equal(captures, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.channels[0].disposeCount, 1);
    assert.equal(f.sources[0].disposed, true);
    assert.equal(f.folderEvents.listenerCount('change'), 0);
    assert.equal(f.errors.length, 0, 'disposed registration does not show new notifications');
}));

for (const when of ['result', 'remember', 'open']) {
    test(`authority revoked at ${when} prevents further success actions without misreporting commit`, () => using(async f => {
        if (when === 'result') { f.bridgeHook = () => { f.workspace.isTrusted = false; }; }
        if (when === 'remember') { f.onRemember = () => f.removeFolder(); }
        if (when === 'open') { f.onInfo = () => f.removeFolder(); }
        await f.run();
        assert.equal(f.state.size, when === 'result' ? 0 : 1);
        assert.equal(f.infos.length, when === 'open' ? 1 : 0);
        assert.equal(f.opened.length, 0);
        assert.deepEqual(f.errors, []);
        assert.match(f.warnings[0], /Publication completed:/);
        assert.match(f.warnings[0], /No further success actions/);
    }));
}

test('removing a different folder does not cancel the selected operation; listeners detach after completion', () => using(async f => {
    const other = { name: 'Other', uri: uri(path.join(f.root, 'other')), index: 1 };
    f.workspace.workspaceFolders.push(other);
    f.bridgeHook = (...args: any[]) => {
        f.removeFolder(other);
        assert.equal(args[4].isCancellationRequested, false);
    };
    await f.run();
    assert.deepEqual(f.errors, []);
    assert.equal(f.state.size, 1);
    assert.equal(f.sources[0].disposed, true);
    assert.equal(f.progressEvents.listenerCount('cancel'), 0);
    f.removeFolder(); f.cancel();
    assert.equal(f.sources[0].token.isCancellationRequested, false);
    f.disposeRegistration();
    assert.equal(f.folderEvents.listenerCount('change'), 0);
    assert.equal(f.channels[0].disposeCount, 1);
}));

for (const fatal of ['timeout', 'overflow', 'transport', 'protocol']) {
    test(`late cancellation never masks ${fatal} even with exit zero`, () => using(async f => {
        f.fakeTimers = true; f.child = fakeChild();
        const running = f.api.runPublicationHelper('/node', '/helper', f.root, envelope, f.token, () => {});
        const rejected = assert.rejects(running, fatal === 'timeout' ? /10 minute/ : fatal === 'overflow' ? /8 MiB/
            : fatal === 'transport' ? /Cannot send publication snapshot/ : /Invalid JSON/);
        f.cancel();
        f.child.stdout.write(fatal === 'protocol' ? 'not json' : committedResponse());
        if (fatal === 'timeout') { f.timers[0].callback(); }
        if (fatal === 'overflow') { f.child.stderr.write(Buffer.alloc(8 * 1024 * 1024)); }
        if (fatal === 'transport') { f.child.stdin.emit('error', new Error('EPIPE')); }
        f.child.emit('close', 0, null);
        await rejected;
        assert.deepEqual(f.child.signals, ['SIGTERM']);
        assert.ok(f.timers.every((timer: any) => timer.cleared));
    }));
}

test('bridge refuses pre-cancelled and oversized input without spawning', () => using(async f => {
    f.cancel();
    assert.throws(() => f.api.runPublicationHelper('/node', '/helper', f.root, envelope, f.token, () => {}), /cancelled/);
    f.token.isCancellationRequested = false;
    assert.throws(() => f.api.runPublicationHelper('/node', '/helper', f.root,
        { ...envelope, documents: [{ path: 'index.literate', text: 'x'.repeat(32 * 1024 * 1024) }] }, f.token, () => {}), /32 MiB/);
    assert.deepEqual(f.spawned, []);
}));
