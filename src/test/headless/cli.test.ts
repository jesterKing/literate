import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve(__dirname, '../../cli.js');

function fixture(t: { after(callback: () => void): void }) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'literate headless '));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'project with spaces');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    return { base, root, outside };
}

function write(root: string, name: string, content: string): void {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function source(filename = 'generated folder/my file.txt', code = 'hello'): string {
    return '# Example\n\n```text: <<main.*>>= ' + filename + ' $\n' + code + '\n```\n';
}

function run(root: string, command: string, ...extra: string[]) {
    assert.ok(fs.existsSync(cli), 'CLI is not compiled: run yarn compile after src/cli.ts is available');
    const result = spawnSync(process.execPath, [cli, command, root, ...extra], {
        encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'CLI must terminate normally');
    return result;
}

function succeeded(result: ReturnType<typeof run>): void {
    assert.equal(result.status, 0, result.stdout + result.stderr);
}

function failed(result: ReturnType<typeof run>): void {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /\S/, 'failure should explain the problem');
}

// Include bytes and timestamps so read-only and atomic-failure assertions also catch rewrites.
function snapshot(root: string): Record<string, { kind: string; value: string; mtime: number }> {
    const entries: Record<string, { kind: string; value: string; mtime: number }> = {};
    function visit(relative: string): void {
        const absolute = path.join(root, relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
            entries[relative] = { kind: 'symlink', value: fs.readlinkSync(absolute), mtime: stat.mtimeMs };
        } else if (stat.isDirectory()) {
            entries[relative] = { kind: 'directory', value: '', mtime: stat.mtimeMs };
            for (const name of fs.readdirSync(absolute).sort()) { visit(path.join(relative, name)); }
        } else {
            entries[relative] = { kind: 'file', value: fs.readFileSync(absolute).toString('base64'), mtime: stat.mtimeMs };
        }
    }
    visit('');
    return entries;
}

function age(root: string, names: string[]): void {
    // A fixed old timestamp makes accidental rewrites observable even on coarse filesystems.
    for (const name of names) { fs.utimesSync(path.join(root, name), new Date('2001-01-01'), new Date('2001-01-01')); }
}

test('generate writes source and HTML, supports spaces, and preserves unchanged mtimes', t => {
    const { root } = fixture(t);
    write(root, 'index.literate', '# Index\n\n[Chapter](chapter%20one.html)\n');
    write(root, 'chapter one.literate', source());
    succeeded(run(root, 'generate'));
    assert.equal(fs.readFileSync(path.join(root, 'generated folder/my file.txt'), 'utf8'), 'hello\n');
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<h1>Index<\/h1>/);
    assert.match(fs.readFileSync(path.join(root, 'chapter one.html'), 'utf8'), /hello/);
    age(root, ['index.html', 'chapter one.html', 'generated folder/my file.txt']);
    const before = snapshot(root);
    succeeded(run(root, 'generate'));
    assert.deepEqual(snapshot(root), before, 'unchanged generate must not rewrite files');
    succeeded(run(root, 'check'));
    assert.deepEqual(snapshot(root), before, 'up-to-date check must be read-only');
});

test('CLI loads source and HTML templates with spaces in their names', t => {
    const { root } = fixture(t);
    write(root, 'index.literate', '```SETTINGS\ntemplate=page layout.template\nauthors=Example\n```\n'
        + '```text: <<main.*>>= output file.txt $ template=source layout.template\n$& [CODE]\n```\n');
    write(root, 'page layout.template', 'PAGE [AUTHORS] [CONTENT] END');
    write(root, 'source layout.template', 'START\n[CODE]END');
    succeeded(run(root, 'generate'));
    assert.equal(fs.readFileSync(path.join(root, 'output file.txt'), 'utf8'), 'START\n$& [CODE]\nEND');
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /^PAGE <meta name="author" content="Example">/);
    succeeded(run(root, 'check'));
});

for (const stale of ['missing outputs', 'modified source output', 'modified HTML', 'changed input', 'deleted output']) {
    test('check reports ' + stale + ' without writing', t => {
        const { root } = fixture(t);
        write(root, 'index.literate', source());
        if (stale !== 'missing outputs') { succeeded(run(root, 'generate')); }
        if (stale === 'modified source output') { write(root, 'generated folder/my file.txt', 'stale source'); }
        if (stale === 'modified HTML') { write(root, 'index.html', 'stale HTML'); }
        if (stale === 'changed input') { write(root, 'index.literate', source(undefined, 'changed')); }
        if (stale === 'deleted output') { fs.unlinkSync(path.join(root, 'generated folder/my file.txt')); }
        const before = snapshot(root);
        failed(run(root, 'check'));
        assert.deepEqual(snapshot(root), before);
    });
}

for (const command of ['generate', 'check']) {
    for (const existing of [false, true]) {
        test(command + ' diagnostics cause no writes' + (existing ? ' and preserve existing outputs' : ''), t => {
            const { root } = fixture(t);
            write(root, 'index.literate', source());
            if (existing) { succeeded(run(root, 'generate')); }
            write(root, 'index.literate', source(undefined, 'changed\n<<missing>>'));
            write(root, 'other.literate', '```text: <<other.*>>= new directory/new.txt $\nvalid\n```\n');
            const before = snapshot(root);
            const result = run(root, command);
            failed(result);
            assert.match(result.stdout + result.stderr, /missing/i);
            assert.deepEqual(snapshot(root), before, 'even valid outputs must wait until all diagnostics are checked');
        });
    }
}

test('invalid usage fails, help succeeds, and neither writes', t => {
    const { root } = fixture(t);
    write(root, 'index.literate', source());
    const before = snapshot(root);
    for (const args of [[], ['unknown', root], ['generate', root, 'unexpected'], ['--unknown']]) {
        assert.ok(fs.existsSync(cli), 'CLI is not compiled: run yarn compile after src/cli.ts is available');
        const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.notEqual(result.status, 0, 'invalid arguments must fail: ' + JSON.stringify(args));
        assert.match(result.stdout + result.stderr, /usage|generate|check|unknown|unexpected/i);
        assert.deepEqual(snapshot(root), before);
    }
    const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.ifError(help.error);
    assert.equal(help.signal, null);
    succeeded(help);
    assert.match(help.stdout + help.stderr, /generate/);
    assert.match(help.stdout + help.stderr, /check/);
    assert.deepEqual(snapshot(root), before);
});

test('omitted root defaults to the current working directory', t => {
    const { root } = fixture(t);
    write(root, 'index.literate', source());
    assert.ok(fs.existsSync(cli), 'CLI is not compiled: run yarn compile after src/cli.ts is available');
    for (const command of ['generate', 'check']) {
        const result = spawnSync(process.execPath, [cli, command], { cwd: root, encoding: 'utf8', timeout: 15000 });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    assert.equal(fs.readFileSync(path.join(root, 'generated folder/my file.txt'), 'utf8'), 'hello\n');
});

for (const command of ['generate', 'check']) {
    test(command + ' skips source symlinks without reading targets or writing outside the project', t => {
        const { root, outside } = fixture(t);
        write(root, 'index.literate', source('safe.txt', 'local source'));
        if (command === 'check') { succeeded(run(root, 'generate')); }
        // Following these links would introduce diagnostics or fail to read the dangling target.
        write(outside, 'outside.literate', source('../outside/sentinel.txt', '<<missing>>'));
        write(outside, 'sentinel.txt', 'do not change');
        fs.symlinkSync(path.join(outside, 'outside.literate'), path.join(root, 'z.literate'));
        fs.symlinkSync(path.join(outside, 'absent.literate'), path.join(root, 'dangling.literate'));
        fs.symlinkSync(outside, path.join(root, 'linked sources'), 'dir');
        const outsideBefore = snapshot(outside);
        const rootBefore = snapshot(root);

        succeeded(run(root, command));

        assert.deepEqual(snapshot(outside), outsideBefore, 'external files and directories must remain unchanged');
        assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'local source\n');
        assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /local source/);
        assert.deepEqual(fs.readdirSync(root).sort(), [
            'dangling.literate', 'index.html', 'index.literate', 'linked sources', 'safe.txt', 'z.literate',
        ], 'skipped sources must not produce source or HTML outputs');
        const after = snapshot(root);
        for (const name of ['z.literate', 'dangling.literate', 'linked sources']) {
            assert.deepEqual(after[name], rootBefore[name], 'source symlinks must remain unchanged');
        }
        if (command === 'check') { assert.deepEqual(after, rootBefore, 'check must remain read-only'); }
    });

    for (const escape of ['output directory', 'output file', 'HTML output', 'template']) {
        test(command + ' rejects escaping ' + escape + ' symlink before any writes', t => {
            const { base, root, outside } = fixture(t);
            write(root, 'index.literate', source('safe.txt', 'valid output must not be written early'));
            write(outside, 'sentinel.txt', 'do not change');
            if (escape === 'output directory') {
                fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
                write(root, 'z.literate', source('linked/escaped.txt').replace('<<main.*>>', '<<escape.*>>'));
            } else if (escape === 'output file') {
                fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(root, 'escaped.txt'));
                write(root, 'z.literate', source('escaped.txt').replace('<<main.*>>', '<<escape.*>>'));
            } else if (escape === 'HTML output') {
                fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(root, 'index.html'));

            } else {
                write(outside, 'outside.template', '[CONTENT]');
                fs.symlinkSync(path.join(outside, 'outside.template'), path.join(root, 'page.template'));
                write(root, 'index.literate', '```SETTINGS\ntemplate=page.template\n```\n' + source('safe.txt'));
            }
            const before = snapshot(base);
            const result = run(root, command);
            failed(result);
            assert.match(result.stdout + result.stderr, /symlink|symbolic|outside|escape/i);
            assert.deepEqual(snapshot(base), before, 'reject escape before touching any project or external output');
        });
    }
}

test('path traversal is rejected before otherwise-valid output is written', t => {
    const { base, root, outside } = fixture(t);
    write(outside, 'sentinel.txt', 'keep');
    write(root, 'index.literate', source('safe.txt'));
    write(root, 'z.literate', source('../outside/sentinel.txt').replace('<<main.*>>', '<<escape.*>>'));
    const before = snapshot(base);
    failed(run(root, 'generate'));
    assert.deepEqual(snapshot(base), before);
});
