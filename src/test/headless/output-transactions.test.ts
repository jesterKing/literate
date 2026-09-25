import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import * as engine from '../../engine';

// Exercise the authoritative chapter without writing generated sources. This also
// keeps these tests runnable while the generated module is deliberately absent.
const chapter = fs.readFileSync(path.resolve(__dirname, '../../../literate/output_transactions.literate'), 'utf8');
const generated = engine.generateProject([{ path: 'output_transactions.literate', text: chapter }]);
assert.deepEqual(generated.diagnostics, []);
const source = generated.files.find(file => file.path === 'src/output-transactions.ts')!.content;
const exportsObject: Record<string, unknown> = {};
new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText)((name: string) => {
    assert.equal(name, './engine');
    return engine;
}, exportsObject);

interface Output { path: string; content: Uint8Array; }
interface TransactionError extends Error {
    code: string;
    committed: boolean;
    paths: string[];
    recoveryPaths: string[];
    changedPaths: string[];
    originalError: unknown;
}
const commitOutputs = exportsObject.commitOutputs as (files: readonly Output[], io: MemoryIO) => Promise<string[]>;
const errorClass = exportsObject.OutputTransactionError as new (...args: never[]) => TransactionError;
const directoryErrorClass = exportsObject.TransactionDirectoryError as
    new (createdPath: string, message?: string) => Error & { createdPath: string };
type Hook = (operation: string, from: string, to: string | undefined, after: boolean) => void;

class MemoryIO {
    entries = new Map<string, Uint8Array | 'directory' | 'unsafe'>([['', 'directory']]);
    events: string[] = [];
    hook: Hook = () => {};
    nonce(): string { return 'test'; }
    async inspect(name: string): Promise<'missing' | 'file' | 'directory'> {
        this.events.push(`inspect ${name}`);
        const parts = name.split('/');
        for (let index = 1; index <= parts.length; index++) {
            const value = this.entries.get(parts.slice(0, index).join('/'));
            if (value === 'unsafe') { throw new Error(`Unsafe entry: ${name}`); }
            if (index < parts.length && value instanceof Uint8Array) { throw new Error(`Non-directory parent: ${name}`); }
        }
        const value = this.entries.get(name);
        return value === undefined ? 'missing' : value === 'directory' ? 'directory' : 'file';
    }
    async read(name: string): Promise<Uint8Array> {
        this.events.push(`read ${name}`);
        const value = this.entries.get(name);
        assert.ok(value instanceof Uint8Array);
        return Buffer.from(value);
    }
    private mutate(operation: string, from: string, to: string | undefined, effect: () => void): void {
        this.events.push(`${operation} ${from}${to ? ' -> ' + to : ''}`);
        this.hook(operation, from, to, false);
        effect();
        this.hook(operation, from, to, true);
    }
    private vacant(name: string): void {
        assert.equal(this.entries.has(name), false, `exclusive create: ${name}`);
        const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
        assert.equal(this.entries.get(parent), 'directory', `parent exists: ${name}`);
    }
    async mkdir(name: string): Promise<void> {
        this.mutate('mkdir', name, undefined, () => {
            this.vacant(name);
            this.entries.set(name, 'directory');
        });
    }
    async writeNew(name: string, content: Uint8Array): Promise<void> {
        this.mutate('write', name, undefined, () => {
            this.vacant(name);
            this.entries.set(name, new Uint8Array(content));
        });
    }
    async rename(from: string, to: string): Promise<void> {
        this.mutate('rename', from, to, () => {
            this.vacant(to);
            const value = this.entries.get(from);
            assert.ok(value instanceof Uint8Array, `rename source: ${from}`);
            this.entries.set(to, value);
            this.entries.delete(from);
        });
    }
    async removeFile(name: string): Promise<void> {
        this.mutate('removeFile', name, undefined, () => {
            assert.ok(this.entries.get(name) instanceof Uint8Array);
            this.entries.delete(name);
        });
    }
    async removeDirectory(name: string): Promise<void> {
        this.mutate('removeDirectory', name, undefined, () => {
            assert.equal(this.entries.get(name), 'directory');
            assert.equal([...this.entries.keys()].some(key => key.startsWith(name + '/')), false, `empty directory: ${name}`);
            this.entries.delete(name);
        });
    }
    snapshot(): unknown {
        return [...this.entries].sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => [name, value instanceof Uint8Array ? [...value] : value]);
    }
}

const output = (name: string, text = 'new'): Output => ({ path: name, content: Buffer.from(text) });
function fixture(): MemoryIO {
    const io = new MemoryIO();
    io.entries.set('a', Buffer.from('old a'));
    io.entries.set('b', Buffer.from('old b'));
    return io;
}
function failOnce(io: MemoryIO, operation: string, step: number, afterEffect = false): void {
    let count = 0;
    io.hook = (op, _from, _to, after) => {
        if (op === operation && after === afterEffect && ++count === step) { throw new Error('injected failure'); }
    };
}
async function rejected(promise: Promise<unknown>, code: string, committed = false): Promise<TransactionError> {
    try { await promise; }
    catch (error) {
        assert.ok(error instanceof errorClass);
        assert.equal(error.code, code);
        assert.equal(error.committed, committed);
        if (!committed) { assert.deepEqual(error.changedPaths, []); }
        for (const name of [...error.paths, ...error.recoveryPaths]) { assert.ok(error.message.includes(name)); }
        return error;
    }
    assert.fail('Expected transaction rejection');
}

// Type-check the virtual module too: transpileModule alone would miss contract and
// control-flow errors. All compiler output remains in memory.
test('authoritative transaction module type-checks without generation', () => {
    const filename = path.resolve(__dirname, '../../../src/output-transactions.ts');
    const options: ts.CompilerOptions = { strict: true, noImplicitReturns: true, noUnusedParameters: true,
        target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, types: ['node', 'mocha'],
        noEmit: true, skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
        path.resolve(name) === filename ? ts.createSourceFile(name, source, languageVersion, true)
            : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'
    }));
});

test('stages the complete batch before replacement, retains originals until commit, returns changed paths', async () => {
    const io = fixture();
    io.entries.set('same', Buffer.from('same'));
    const result = await commitOutputs([output('./a'), output('same', 'same'), output('nested/b')], io);
    assert.deepEqual(result, ['a', 'nested/b']);
    assert.deepEqual(await io.read('a'), Buffer.from('new'));
    assert.deepEqual(await io.read('nested/b'), Buffer.from('new'));
    const writes = io.events.map((event, index) => event.startsWith('write ') ? index : -1).filter(index => index >= 0);
    const moves = io.events.map((event, index) => event.startsWith('rename ') ? index : -1).filter(index => index >= 0);
    assert.ok(Math.max(...writes) < Math.min(...moves));
    assert.ok(io.events.findIndex(event => event.startsWith('removeFile ') && event.endsWith('.backup')) > Math.max(...moves));
    assert.equal([...io.entries.keys()].some(name => name.includes('.literate-txn-')), false);
    assert.equal(io.events.some(event => /^(write|rename|mkdir|remove)/.test(event) && event.includes('same')), false);
});

test('unchanged bytes and empty batches perform no mutations or nonce allocation', async () => {
    const io = fixture();
    io.nonce = () => { throw new Error('must not allocate'); };
    assert.deepEqual(await commitOutputs([output('a', 'old a')], io), []);
    assert.deepEqual(await commitOutputs([], io), []);
    assert.ok(io.events.every(event => /^(inspect|read) /.test(event)));
});

for (const operation of ['write', 'rename']) {
    for (const step of operation === 'write' ? [1, 2] : [1, 2, 3, 4]) {
        for (const after of [false, true]) {
            test(`${operation} failure ${step}, after effect=${after}, restores exact old tree`, async () => {
                const io = fixture();
                const before = io.snapshot();
                failOnce(io, operation, step, after);
                const error = await rejected(commitOutputs([output('a'), output('b')], io), 'rolled_back');
                assert.deepEqual(error.recoveryPaths, []);
                assert.deepEqual(io.snapshot(), before);
            });
        }
    }
}

for (const after of [false, true]) {
    test(`new outputs and newly created parents roll back, after effect=${after}`, async () => {
        const io = fixture();
        io.entries.set('existing', 'directory');
        const before = io.snapshot();
        failOnce(io, 'rename', 3, after);
        await rejected(commitOutputs([output('existing/new'), output('deep/sub/new'), output('a')], io), 'rolled_back');
        assert.deepEqual(io.snapshot(), before);
    });
}

test('write failure cleans partial stages and deep empty parents', async () => {
    const io = fixture();
    const before = io.snapshot();
    failOnce(io, 'write', 2, true);
    await rejected(commitOutputs([output('deep/sub/new'), output('elsewhere/new')], io), 'rolled_back');
    assert.deepEqual(io.snapshot(), before);
});

test('exclusive mkdir failure removes only previously created empty parents', async () => {
    const io = fixture();
    const before = io.snapshot();
    failOnce(io, 'mkdir', 2);
    await rejected(commitOutputs([output('deep/sub/new')], io), 'rolled_back');
    assert.deepEqual(io.snapshot(), before);
});

for (const kind of ['stage', 'parent']) {
    for (const persistent of [false, true]) {
        test(`known created ${kind} directory retries cleanup, persistent failure=${persistent}`, async () => {
            const io = fixture();
            const before = io.snapshot();
            const createdPath = kind === 'stage' ? '.literate-txn-test' : 'missing';
            const files = [output(kind === 'stage' ? 'a' : 'missing/new')];
            const mkdir = io.mkdir.bind(io);
            let removalAttempts = 0;
            let directoryError: Error | undefined;
            io.hook = (operation, from, _to, after) => {
                if (operation === 'removeDirectory' && from === createdPath && !after) {
                    removalAttempts++;
                    if (persistent || removalAttempts === 1) { throw new Error('compensating deletion blocked'); }
                }
            };
            io.mkdir = async name => {
                await mkdir(name);
                if (name !== createdPath) { return; }
                // Model the adapter's compensation after a provider mkdir throws
                // after effect, with positive knowledge that this call created it.
                try { await io.removeDirectory(name); }
                catch (error) {
                    directoryError = new directoryErrorClass(name, String(error));
                    throw directoryError;
                }
                assert.fail('Expected adapter compensation to fail');
            };
            const error = await rejected(commitOutputs(files, io), persistent ? 'rollback_failed' : 'rolled_back');
            assert.equal(error.originalError, directoryError);
            assert.equal(removalAttempts, 2, 'adapter compensation plus coordinator retry');
            assert.deepEqual(error.paths, [createdPath]);
            if (persistent) {
                assert.deepEqual(error.recoveryPaths, [createdPath]);
                assert.equal(io.entries.get(createdPath), 'directory');
                assert.match(error.message, /compensating deletion blocked/);
                io.entries.delete(createdPath);
            } else {
                assert.deepEqual(error.recoveryPaths, []);
            }
            assert.deepEqual(io.snapshot(), before);
            assert.equal(io.events.some(event => /^(write|rename) /.test(event)), false);
        });
    }

    test(`generic mkdir rejection never claims a foreign ${kind} directory`, async () => {
        const io = fixture();
        const foreignPath = kind === 'stage' ? '.literate-txn-test' : 'missing';
        const mkdir = io.mkdir.bind(io);
        io.mkdir = async name => {
            if (name === foreignPath) {
                io.entries.set(name, 'directory');
                throw new Error('another writer won exclusive mkdir');
            }
            await mkdir(name);
        };
        const error = await rejected(commitOutputs([output(kind === 'stage' ? 'a' : 'missing/new')], io), 'rolled_back');
        assert.deepEqual(error.recoveryPaths, []);
        assert.equal(io.entries.get(foreignPath), 'directory');
        assert.equal(io.events.some(event => event === `removeDirectory ${foreignPath}`), false);
    });
}

test('typed mkdir rejection for a different path does not authorize deletion', async () => {
    const io = fixture();
    io.entries.set('foreign', 'directory');
    io.mkdir = async () => { throw new directoryErrorClass('foreign'); };
    const error = await rejected(commitOutputs([output('a')], io), 'rolled_back');
    assert.deepEqual(error.recoveryPaths, []);
    assert.equal(io.entries.get('foreign'), 'directory');
    assert.equal(io.events.some(event => event.startsWith('removeDirectory ')), false);
});

test('rollback restore failure preserves backups and stages and reports every failed target', async () => {
    const io = fixture();
    io.hook = (op, from, to, after) => {
        if (op !== 'rename' || after) { return; }
        if (from.endsWith('.backup') || to === 'b') { throw new Error(`cannot move ${from}`); }
    };
    const error = await rejected(commitOutputs([output('a'), output('b')], io), 'rollback_failed');
    assert.ok(error.paths.includes('a'));
    assert.ok(error.paths.includes('b'));
    assert.deepEqual(error.recoveryPaths, ['.literate-txn-test']);
    assert.deepEqual(await io.read('.literate-txn-test/0.backup'), Buffer.from('old a'));
    assert.deepEqual(await io.read('.literate-txn-test/1.backup'), Buffer.from('old b'));
    assert.deepEqual(await io.read('.literate-txn-test/1.stage'), Buffer.from('new'));
    assert.equal(io.events.some(event => event.startsWith('removeDirectory ')), false);
});

test('rollback restore rename throwing after effect counts as restored', async () => {
    const io = fixture();
    const before = io.snapshot();
    io.hook = (op, from, to, after) => {
        if (op === 'rename' && ((!after && to === 'b' && from.endsWith('.stage')) || (after && from.endsWith('.backup')))) {
            throw new Error('move rejected');
        }
    };
    await rejected(commitOutputs([output('a'), output('b')], io), 'rolled_back');
    assert.deepEqual(io.snapshot(), before);
});

test('missing original backup never causes destructive target deletion', async () => {
    const io = fixture();
    io.hook = (op, from, to, after) => {
        if (op === 'rename' && to === 'a' && after) {
            io.entries.delete('.literate-txn-test/0.backup');
            throw new Error(`lost backup after ${from}`);
        }
    };
    const error = await rejected(commitOutputs([output('a')], io), 'rollback_failed');
    assert.match(error.message, /Original backup unavailable/);
    assert.deepEqual(await io.read('a'), Buffer.from('new'));
    assert.equal(io.events.some(event => event === 'removeFile a'), false);
});

test('rollback remove failure retains recovery backup', async () => {
    const io = fixture();
    io.hook = (op, _from, to, after) => {
        if (!after && ((op === 'rename' && to === 'b') || op === 'removeFile')) { throw new Error('blocked'); }
    };
    await rejected(commitOutputs([output('a'), output('b')], io), 'rollback_failed');
    assert.deepEqual(await io.read('a'), Buffer.from('new'));
    assert.deepEqual(await io.read('.literate-txn-test/0.backup'), Buffer.from('old a'));
});

test('post-commit cleanup failure is explicitly committed and never rolls back', async () => {
    const io = fixture();
    io.entries.set('same', Buffer.from('same'));
    failOnce(io, 'removeFile', 1);
    const error = await rejected(commitOutputs([output('./a'), output('same', 'same'), output('b')], io), 'cleanup_failed', true);
    assert.deepEqual(error.changedPaths, ['a', 'b']);
    assert.match(error.message, /committed, cleanup failed/);
    assert.ok(error.paths.includes('.literate-txn-test/0.backup'));
    assert.ok(error.paths.includes('.literate-txn-test'));
    assert.deepEqual(await io.read('a'), Buffer.from('new'));
    assert.deepEqual(await io.read('b'), Buffer.from('new'));
    assert.deepEqual(await io.read('.literate-txn-test/0.backup'), Buffer.from('old a'));
    assert.equal(io.events.filter(event => event.startsWith('rename ')).length, 4);
});

test('rollback cleanup failure reports uncommitted and leaves accessible stage', async () => {
    const io = fixture();
    io.hook = (op, _from, _to, after) => {
        if (!after && (op === 'rename' || op === 'removeFile')) { throw new Error('blocked'); }
    };
    const error = await rejected(commitOutputs([output('a')], io), 'rollback_failed');
    assert.deepEqual(await io.read('a'), Buffer.from('old a'));
    assert.deepEqual(await io.read('.literate-txn-test/0.stage'), Buffer.from('new'));
    assert.ok(error.paths.includes('.literate-txn-test/0.stage'));
});

for (const names of [['a', 'A'], ['x/../a', 'a'], ['dir', 'DIR/child'], ['dir/child', 'DIR'], ['../escape'], ['bad\\path'], ['CON']]) {
    test(`invalid output set is rejected without mutations: ${names.join(', ')}`, async () => {
        const io = fixture();
        const before = io.snapshot();
        await rejected(commitOutputs(names.map(name => output(name)), io), 'preflight_failed');
        assert.deepEqual(io.snapshot(), before);
        assert.equal(io.events.length, 0);
    });
}

for (const value of ['directory', 'unsafe', Buffer.from('parent file')] as const) {
    test(`later invalid type rejects entire batch before writing: ${String(value)}`, async () => {
        const io = fixture();
        io.entries.set('invalid', value);
        const before = io.snapshot();
        const name = value === 'directory' ? 'invalid' : 'invalid/child';
        await rejected(commitOutputs([output('new/sub/file'), output(name)], io), 'preflight_failed');
        assert.deepEqual(io.snapshot(), before);
        assert.ok(io.events.every(event => /^(inspect|read) /.test(event)));
    });
}

test('all comparisons finish before any directory creation', async () => {
    const io = fixture();
    const read = io.read.bind(io);
    io.read = async name => {
        if (name === 'b') { throw new Error('cannot read'); }
        return read(name);
    };
    await rejected(commitOutputs([output('deep/new'), output('a'), output('b')], io), 'preflight_failed');
    assert.ok(io.events.every(event => /^(inspect|read) /.test(event)));
});

for (const collision of ['file', 'directory', 'planned']) {
    test(`stage directory collision refused, never reused: ${collision}`, async () => {
        const io = fixture();
        if (collision !== 'planned') { io.entries.set('.literate-txn-test', collision === 'file' ? Buffer.from('foreign') : 'directory'); }
        const before = io.snapshot();
        const files = [output('a')];
        if (collision === 'planned') { files.push(output('.LITERATE-txn-test/child')); }
        const error = await rejected(commitOutputs(files, io), 'preflight_failed');
        assert.match(error.message, /stage collision/);
        assert.deepEqual(io.snapshot(), before);
        assert.ok(io.events.every(event => /^(inspect|read) /.test(event)));
    });
}

test('long output names use short numbered staging names', async () => {
    const io = fixture();
    await commitOutputs([output('x'.repeat(250))], io);
    assert.ok(io.events.includes('write .literate-txn-test/0.stage'));
});
