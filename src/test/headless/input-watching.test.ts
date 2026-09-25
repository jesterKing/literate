import assert = require('node:assert/strict');
import { test } from 'node:test';
import { fixture, fence, root, tick } from './vscode-fixture';

const settle = async () => { await new Promise(resolve => setTimeout(resolve, 180)); await tick(); };

for (const workspaceUri of ['file:///project', 'vscode-remote://ssh-remote+host/project']) {
    test(`template editor changes are immediate and use current buffers: ${workspaceUri}`, async t => {
        const f = fixture(workspaceUri);
        t.after(() => f.repository.dispose());
        f.put('index.literate', fence('SETTINGS', 'template=page.custom') + root('hello', 'template=LICENSE'));
        f.put('page.custom', '<old>[CONTENT]</old>');
        f.put('LICENSE', 'old [CODE]');
        await f.process(true);
        const before = f.discoveries();
        await f.change(f.open('LICENSE', 'new [CODE]'));
        assert.equal(f.discoveries(), before + 1);
        assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'new hello\n');
        await f.change(f.open('page.custom', '<new>[CONTENT]</new>'));
        assert.match(f.disk.get(f.uri('index.html'))!.toString(), /<new>/);
        const unchanged = f.discoveries();
        await f.change(f.open('unreferenced.template', '[CODE]'));
        await f.change(f.open('LICENSE', 'other [CODE]', f.other));
        assert.equal(f.discoveries(), unchanged);
    });
}

test('saved input bursts coalesce, add and remove chapters, and ignore outputs and vendor directories', async t => {
    const f = fixture();
    t.after(() => f.repository.dispose());
    f.put('index.literate', root('initial'));
    await f.process(true);
    const before = f.discoveries();
    f.put('index.literate', root('external'));
    f.put('chapter.literate', '# Chapter');
    f.fileEvent('change', 'index.literate');
    f.fileEvent('create', 'chapter.literate');
    f.fileEvent('change', 'index.literate');
    await settle();
    assert.equal(f.discoveries(), before + 1);
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'external\n');
    assert.ok(f.disk.has(f.uri('chapter.html')));
    f.disk.delete(f.uri('chapter.literate'));
    f.fileEvent('delete', 'chapter.literate');
    await settle();
    assert.equal(f.repository.getWorkspaceState(f.folder as never).list.length, 1);
    const ignored = f.discoveries();
    for (const name of ['generated/main.txt', 'index.html', 'unused.template', 'node_modules/a.literate',
        'nested/dist/a.literate', '.git/a.literate', 'out/a.literate', '.yarn/a.literate', '.vscode-test/a.literate']) {
        f.fileEvent('change', name);
        await f.change(f.document(name, root('ignored')));
    }
    await settle();
    assert.equal(f.discoveries(), ignored);
});

for (const workspaceUri of ['file:///project', 'vscode-remote://ssh-remote+host/project']) {
    test(`generated .literate output events never enqueue processing: ${workspaceUri}`, { timeout: 5000 }, async t => {
        const f = fixture(workspaceUri);
        t.after(() => f.repository.dispose());
        const output = 'generated/chapter.literate';
        f.put('index.literate', fence(`text: <<main.*>>= ${output} $`, 'generated text'));
        // The fixture emits filesystem and awaited editor events during stage/commit.
        await f.process(true);
        assert.equal(f.disk.get(f.uri(output))?.toString(), 'generated text\n');
        const before = f.discoveries();
        for (const kind of ['create', 'change', 'delete'] as const) { f.fileEvent(kind, output); }
        await f.change(f.document(output, 'generated text'));
        await settle();
        assert.equal(f.discoveries(), before, 'generated .literate events must not enqueue work');
        assert.equal(f.errors.length, 0);
    });
}

test('missing custom templates recover on create, change, and delete without stale writes', async t => {
    const f = fixture();
    t.after(() => f.repository.dispose());
    f.put('index.literate', root('hello', 'template=custom'));
    await f.process(true);
    assert.ok(f.diagnostics.size);
    assert.equal(f.writes.length, 0);
    f.put('custom', 'created [CODE]');
    f.fileEvent('create', 'custom');
    await settle();
    assert.equal(f.diagnostics.size, 0);
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'created hello\n');
    f.put('custom', 'changed [CODE]');
    f.fileEvent('change', 'custom');
    await settle();
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'changed hello\n');
    f.writes.length = 0;
    f.disk.delete(f.uri('custom'));
    f.fileEvent('delete', 'custom');
    await settle();
    assert.ok(f.diagnostics.size);
    assert.equal(f.writes.length, 0);
    f.put('custom', 'restored [CODE]');
    f.fileEvent('create', 'custom');
    await settle();
    assert.equal(f.diagnostics.size, 0);
});

test('new template references in unsaved invalid projects are watched immediately', async t => {
    const f = fixture();
    t.after(() => f.repository.dispose());
    f.put('index.literate', root('old'));
    await f.process(true);
    const index = f.open('index.literate', root('new', 'template=new.wrapper'));
    await f.change(index);
    assert.ok(f.diagnostics.size);
    await f.change(f.open('new.wrapper', 'buffer [CODE]'));
    assert.equal(f.diagnostics.size, 0);
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'buffer new\n');
    const before = f.discoveries();
    f.open('index.literate', root('no template'));
    await f.change(f.open('new.wrapper', 'no longer referenced [CODE]'));
    assert.equal(f.discoveries(), before);
});

test('filesystem work waits for existing writes and snapshots buffers when dequeued', async t => {
    const f = fixture();
    t.after(() => f.repository.dispose());
    f.put('index.literate', root('first'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    f.controls.beforeWrite = async () => { entered(); await gate; };
    const first = f.process(true);
    await writing;
    f.fileEvent('change', 'index.literate');
    await settle();
    assert.equal(f.discoveries(), 1, 'debounced work must remain behind the active write');
    f.open('index.literate', root('latest buffer'));
    f.controls.beforeWrite = undefined;
    release();
    await first;
    // A read-only request is also a barrier behind the filesystem request.
    await f.process();
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'latest buffer\n');
    assert.equal(f.discoveries(), 3);
});

test('disposed repository skips watcher work already queued behind an active operation', { timeout: 5000 }, async t => {
    const f = fixture();
    f.put('index.literate', root('first'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    t.after(() => { release(); f.repository.dispose(); });
    f.controls.beforeWrite = async () => { entered(); await gate; };
    const first = f.process(true);
    await writing;
    f.fileEvent('change', 'index.literate');
    await settle();
    assert.equal(f.discoveries(), 1, 'watcher operation is queued behind the blocked writer');
    f.repository.dispose();
    f.put('index.literate', root('must not be read'));
    f.controls.beforeWrite = undefined;
    release();
    await first;
    await f.process(); // Queue barrier; requests submitted after disposal must also be no-ops.
    assert.equal(f.discoveries(), 1);
    assert.equal(f.reads.filter(uri => uri === f.uri('index.literate')).length, 1);
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'first\n');
    assert.equal(f.writes.length, 2, 'only the already-active operation may finish its writes');
    assert.equal(f.repository.fragmentsForWorkspaceFolders.size, 0);
    assert.equal(f.repository.grabbedStateForWorkspaceFolders.size, 0);
});

test('filesystem refresh reads current buffers and updates root theme', async t => {
    const f = fixture();
    t.after(() => f.repository.dispose());
    f.put('index.literate', root('disk'));
    await f.process(true);
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine-dawn') + root('buffer'));
    f.fileEvent('change', 'index.literate');
    await settle();
    assert.equal(f.disk.get(f.uri('generated/main.txt'))?.toString(), 'buffer\n');
    assert.equal(f.repository.getPreviewTheme(f.document('index.literate', '').uri), 'rosepine-dawn');
});

test('filesystem timers are per workspace and disposal cancels pending work and subscriptions', async () => {
    const f = fixture();
    f.workspace.workspaceFolders.push(f.other);
    f.put('index.literate', root('first'));
    f.put('index.literate', root('second'), f.other);
    f.fileEvent('create', 'index.literate');
    f.fileEvent('create', 'index.literate', f.other);
    await settle();
    assert.equal(f.discoveries(), 2);
    assert.equal(f.disk.get(f.uri('generated/main.txt', f.other))?.toString(), 'second\n');
    f.fileEvent('change', 'index.literate');
    f.repository.dispose();
    f.fileEvent('create', 'new.literate');
    await f.change(f.document('index.literate', root('ignored')));
    await settle();
    assert.equal(f.discoveries(), 2);
});
