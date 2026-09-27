import assert = require('node:assert/strict');
import { test } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { maximumRequestBytes, parseRequest, readRequest, validateRuntime } from '../../publication-helper';

const request = { args: ['latex', '--output', 'book.tex', '--json'], documents: [] };

test('helper accepts only one publication JSON request', () => {
    assert.deepEqual(parseRequest(JSON.stringify(request)), request);
    for (const value of [null, [], {}, { ...request, extra: true },
        { ...request, args: ['generate', '--json'] },
        { ...request, args: ['pdf'] }, { ...request, args: ['latex', '--json', '--help'] },
        { ...request, args: ['pdf', '--json', 1] }, { ...request, documents: {} }]) {
        assert.throws(() => parseRequest(JSON.stringify(value)));
    }
    assert.throws(() => parseRequest('{}\n{}'));
});

test('runtime floor is external Node 22.12 and is independent of CLI imports', () => {
    for (const node of ['22.12.0', '22.13.0', '24.0.0']) { validateRuntime({ node }); }
    for (const node of ['20.20.0', '22.11.0', 'invalid']) {
        assert.throws(() => validateRuntime({ node }), /external Node/);
    }
    assert.throws(() => validateRuntime({ node: '24.0.0', electron: '40.0.0' }), /not Electron/);
});

test('request reader accepts split UTF-8 and rejects oversized input', async () => {
    const text = JSON.stringify({ ...request, documents: [{ path: 'index.literate', text: 'é' }] });
    const bytes = Buffer.from(text);
    assert.equal(await readRequest(Readable.from([...bytes].map(byte => Buffer.from([byte]))),
        new AbortController().signal), text);
    await assert.rejects(readRequest(Readable.from([Buffer.alloc(maximumRequestBytes + 1)]),
        new AbortController().signal), /exceeds 32 MiB/);
});

test('cancellation before or during request delivery rejects and detaches listeners', async () => {
    for (const early of [true, false]) {
        const controller = new AbortController();
        const input = new PassThrough();
        if (early) { controller.abort(); }
        const reading = readRequest(input, controller.signal);
        if (!early) { input.write('{'); controller.abort(); }
        await assert.rejects(reading, /cancelled/);
        assert.equal(input.listenerCount('data'), 0);
        assert.equal(input.listenerCount('end'), 0);
        input.destroy();
    }
});

test('helper executable emits exactly one JSON failure with no stderr chatter', () => {
    for (const input of ['not json', JSON.stringify({ ...request, args: ['generate', '--json'] }),
        JSON.stringify(request)]) {
        const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../publication-helper.js')], {
            input, encoding: 'utf8', timeout: 10000
        });
        assert.ifError(child.error);
        assert.equal(child.signal, null);
        assert.equal(child.status, 1);
        assert.equal(child.stderr, '');
        const response = JSON.parse(child.stdout);
        assert.equal(response.schemaVersion, 1);
        assert.equal(response.ok, false);
        assert.ok(response.errors.length);
        assert.deepEqual(response.outputs, []);
    }
});

test('importing CLI does not execute an argument-driven command', () => {
    const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1])',
        path.resolve(__dirname, '../../cli.js'), '--', 'unknown', '--json'], {
        encoding: 'utf8', timeout: 10000
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
});
