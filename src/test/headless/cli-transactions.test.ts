import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTransactionIO, run } from '../../cli';
import { commitOutputs, OutputTransactionError, TransactionIO } from '../../output-transactions';

async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'literate transactions '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

const file = (name: string, content: string) => ({ path: name, content: Buffer.from(content) });

async function command(root: string, factory: (root: string) => TransactionIO = createTransactionIO) {
    let stdout = '';
    let stderr = '';
    const code = await run(['generate', root, '--json'], {
        stdout: text => { stdout += text; }, stderr: text => { stderr += text; }
    }, factory);
    assert.equal(stderr, '');
    const response: { ok: boolean; errors: string[]; outputs: { path: string; status: string }[] } = JSON.parse(stdout);
    assert.equal(response.ok, code === 0);
    return { code, response };
}

async function source(root: string): Promise<void> {
    await fs.writeFile(path.join(root, 'index.literate'),
        '```text: <<first.*>>= first.txt $\nfirst\n```\n'
        + '```text: <<second.*>>= nested/second.txt $\nsecond\n```\n');
}

test('Node transaction commits changed files, preserves modes, and leaves unchanged files untouched', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'old'), 'before');
    await fs.writeFile(path.join(root, 'same'), 'same');
    await fs.chmod(path.join(root, 'old'), 0o751);
    const before = await fs.stat(path.join(root, 'same'));
    const files = [file('old', 'after'), file('same', 'same'), file('nested/new', 'new')];
    assert.deepEqual(await commitOutputs(files, createTransactionIO(root)), ['old', 'nested/new']);
    assert.equal(await fs.readFile(path.join(root, 'old'), 'utf8'), 'after');
    assert.equal(await fs.readFile(path.join(root, 'nested/new'), 'utf8'), 'new');
    if (process.platform !== 'win32') { assert.equal((await fs.stat(path.join(root, 'old'))).mode & 0o7777, 0o751); }
    assert.equal((await fs.stat(path.join(root, 'same'))).mtimeMs, before.mtimeMs);
    assert.equal((await fs.stat(path.join(root, 'same'))).ino, before.ino);
    assert.deepEqual(await commitOutputs(files, createTransactionIO(root)), []);
    assert.deepEqual((await fs.readdir(root)).sort(), ['nested', 'old', 'same']);
    assert.deepEqual(await fs.readdir(path.join(root, 'nested')), ['new']);
});

test('Node transaction rolls back a rename failure after effect, restoring bytes, modes and absence', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'old'), 'before');
    await fs.chmod(path.join(root, 'old'), 0o740);
    const io = createTransactionIO(root);
    await assert.rejects(commitOutputs([file('old', 'after'), file('nested/new', 'new')], {
        ...io,
        async rename(from, to) {
            await io.rename(from, to);
            if (from.endsWith('.stage') && to === 'nested/new') { throw new Error('injected after rename'); }
        }
    }), (error: unknown) => {
        assert.ok(error instanceof OutputTransactionError);
        assert.equal(error.code, 'rolled_back');
        assert.equal(error.committed, false);
        return true;
    });
    assert.equal(await fs.readFile(path.join(root, 'old'), 'utf8'), 'before');
    if (process.platform !== 'win32') { assert.equal((await fs.stat(path.join(root, 'old'))).mode & 0o7777, 0o740); }
    assert.deepEqual(await fs.readdir(root), ['old']);
});

test('Node adapter rejects unsafe paths, links, invalid parents and overwrites; removals are nonrecursive', async t => {
    const root = await fixture(t);
    const io = createTransactionIO(root);
    await fs.writeFile(path.join(root, 'file'), 'keep');
    await fs.mkdir(path.join(root, 'directory'));
    await fs.writeFile(path.join(root, 'directory/child'), 'keep');
    assert.equal(await io.inspect('directory'), 'directory');
    assert.equal(await io.inspect('absent/deep/file'), 'missing');
    for (const name of ['../escape', '/absolute', 'file/child']) { await assert.rejects(io.inspect(name)); }
    await assert.rejects(io.rename('file', 'directory/child'));
    await assert.rejects(io.writeNew('file', Buffer.from('overwrite')));
    await assert.rejects(io.mkdir('directory'));
    await assert.rejects(io.removeDirectory('directory'));
    assert.equal(await fs.readFile(path.join(root, 'file'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(root, 'directory/child'), 'utf8'), 'keep');
    if (process.platform !== 'win32') {
        await fs.symlink('absent', path.join(root, 'dangling'));
        await fs.symlink('directory', path.join(root, 'link'));
        await fs.symlink(root, path.join(root, 'root-link'));
        await assert.rejects(io.inspect('dangling'));
        await assert.rejects(io.inspect('link/absent'));
        await assert.rejects(createTransactionIO(path.join(root, 'root-link')).inspect('file'));
    }
});

test('CLI reports written only for a committed batch and leaves a second generation untouched', async t => {
    const root = await fixture(t);
    await source(root);
    const first = await command(root);
    assert.equal(first.code, 0);
    assert.ok(first.response.outputs.length >= 2);
    assert.ok(first.response.outputs.every(output => output.status === 'written'));
    const before = await fs.stat(path.join(root, 'first.txt'));
    const second = await command(root);
    assert.equal(second.code, 0);
    assert.ok(second.response.outputs.every(output => output.status === 'current'));
    assert.equal((await fs.stat(path.join(root, 'first.txt'))).mtimeMs, before.mtimeMs);
});

test('CLI rollback never reports earlier installs as written', async t => {
    const root = await fixture(t);
    await source(root);
    await fs.writeFile(path.join(root, 'first.txt'), 'old');
    const result = await command(root, directory => {
        const io = createTransactionIO(directory);
        return { ...io, async rename(from, to) {
            if (from.endsWith('.stage') && to === 'nested/second.txt') { throw new Error('injected install failure'); }
            await io.rename(from, to);
        } };
    });
    assert.equal(result.code, 1);
    assert.ok(result.response.outputs.every(output => output.status !== 'written'));
    assert.match(result.response.errors.join(' '), /rolled_back/);
    assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'old');
    assert.deepEqual((await fs.readdir(root)).sort(), ['first.txt', 'index.literate']);
});

test('CLI rechecks unchanged candidates before starting a transaction', async t => {
    const root = await fixture(t);
    await source(root);
    assert.equal((await command(root)).code, 0);
    await fs.writeFile(path.join(root, 'nested/second.txt'), 'stale');
    const result = await command(root, directory => {
        const io = createTransactionIO(directory);
        return { ...io, async inspect(value) {
            if (value === 'first.txt') { throw new Error('injected unchanged inspection failure'); }
            return io.inspect(value);
        }, async mkdir() { assert.fail('No mutation before full preflight'); } };
    });
    assert.equal(result.code, 1);
    assert.match(result.response.errors.join(' '), /preflight_failed/);
    assert.equal(await fs.readFile(path.join(root, 'nested/second.txt'), 'utf8'), 'stale');
    assert.ok(result.response.outputs.every(output => output.status !== 'written'));
});

test('CLI cleanup failure reports committed statuses and recovery paths without rollback', async t => {
    const root = await fixture(t);
    await source(root);
    assert.equal((await command(root)).code, 0);
    await fs.writeFile(path.join(root, 'first.txt'), 'old');
    const result = await command(root, directory => {
        const io = createTransactionIO(directory);
        return { ...io, async removeFile(value) {
            if (value.endsWith('.backup')) { throw new Error('injected cleanup failure'); }
            await io.removeFile(value);
        } };
    });
    assert.equal(result.code, 1);
    assert.equal(result.response.outputs.find(output => output.path === 'first.txt')?.status, 'written');
    assert.equal(result.response.outputs.find(output => output.path === 'nested/second.txt')?.status, 'current');
    assert.match(result.response.errors.join(' '), /committed, cleanup failed.*recovery locations:.*\.literate-txn-/);
    assert.notEqual(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'old');
    // Numbered recovery files must not become literate inputs on the next run.
    const next = await command(root);
    assert.equal(next.code, 0);
    assert.ok(next.response.outputs.every(output => output.status === 'current'));
});
