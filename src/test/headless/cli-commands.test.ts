import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProjectInspection, GenerationDiagnostic } from '../../engine';

const cli = path.resolve(__dirname, '../../cli.js');
const environment = { ...process.env };
environment.NODE_PATH = path.resolve(__dirname, '../../../node_modules');
interface Response {
    schemaVersion: number;
    command: string;
    ok: boolean;
    root?: string;
    diagnostics: GenerationDiagnostic[];
    errors: string[];
    outputs: { path: string; status: string }[];
    inspection?: ProjectInspection;
    selfHosting?: { ok: boolean; checks: { name: string; ok: boolean; message?: string }[] };
    usage?: string;
}

function fixture(t: { after(callback: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate commands '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function source(code = '<<piece>> <<piece>> \\<<literal>>'): string {
    return '```text: <<main.*>>= result.txt $\n' + code + '\n```\n'
        + '```text: <<piece>>=\nhello\n```\n';
}

function run(args: string[], cwd: string, executable = cli) {
    const result = spawnSync(process.execPath, [executable, ...args], {
            cwd, encoding: 'utf8', timeout: 30000,
            env: environment
        });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.stderr, '', 'JSON mode must not mix stderr logging into its protocol');
    const response: Response = JSON.parse(result.stdout);
    assert.equal(response.schemaVersion, 1);
    assert.equal(response.ok, result.status === 0);
    assert.ok(Array.isArray(response.diagnostics));
    assert.ok(Array.isArray(response.errors));
    assert.ok(Array.isArray(response.outputs));
    return { response, status: result.status };
}

function snapshot(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(file)
            : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'utf8')];
    });
}

test('inspect JSON locates definitions and references without generating or reading outputs', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'index.literate'), source());
    // An output directory would fail generation preflight, but must not block inspection.
    fs.mkdirSync(path.join(root, 'result.txt'));
    const before = snapshot(root);
    const { response, status } = run(['--json', 'inspect', root], root);
    assert.equal(status, 0);
    assert.equal(response.command, 'inspect');
    assert.deepEqual(response.outputs, []);
    assert.deepEqual(response.inspection?.documents, ['index.literate']);
    const main = response.inspection?.fragments[0];
    assert.equal(main?.name, 'main.*');
    assert.equal(main?.output, 'result.txt');
    assert.deepEqual(main?.definitions, [{ path: 'index.literate', line: 0, column: 0 }]);
    assert.deepEqual(main?.references.map(reference => reference.name), ['piece', 'piece']);
    assert.deepEqual(snapshot(root), before);
});

test('inspect returns partial metadata and zero-based diagnostics for a broken project', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'index.literate'), source('  <<absent>>'));
    const before = snapshot(root);
    const { response, status } = run(['inspect', root, '--json'], root);
    assert.equal(status, 1);
    assert.equal(response.inspection?.fragments[0].references[0].name, 'absent');
    assert.deepEqual(response.diagnostics[0], {
        path: 'index.literate', line: 1, column: 2, message: 'Missing fragment: absent'
    });
    assert.deepEqual(snapshot(root), before);
});

test('JSON generate and check report missing, written, current, and stale without log noise', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'index.literate'), source());
    const before = snapshot(root);
    const missing = run(['check', '--json', root], root);
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.response.outputs.map(file => file.status), ['missing', 'missing']);
    assert.deepEqual(snapshot(root), before);
    const generated = run(['generate', root, '--json'], root);
    assert.equal(generated.status, 0);
    assert.deepEqual(generated.response.outputs.map(file => file.status), ['written', 'written']);
    const current = snapshot(root);
    for (const command of ['generate', 'check']) {
        const result = run([command, root, '--json'], root);
        assert.equal(result.status, 0);
        assert.ok(result.response.outputs.every(file => file.status === 'current'));
        assert.deepEqual(snapshot(root), current);
    }
    fs.writeFileSync(path.join(root, 'result.txt'), 'stale');
    const staleBefore = snapshot(root);
    const stale = run(['check', root, '--json'], root);
    assert.equal(stale.status, 1);
    assert.deepEqual(stale.response.outputs.find(file => file.path === 'result.txt'), { path: 'result.txt', status: 'stale' });
    assert.deepEqual(snapshot(root), staleBefore);
});

test('JSON failures are structured for generation diagnostics, IO, empty roots, and usage', t => {
    const root = fixture(t);
    for (const command of ['generate', 'check', 'inspect', 'self-check']) {
        const empty = run([command, root, '--json'], root);
        assert.equal(empty.status, 1);
        assert.match(empty.response.errors.join(' '), /No literate/);
    }
    fs.writeFileSync(path.join(root, 'index.literate'), source('<<absent>>'));
    const before = snapshot(root);
    const invalid = run(['generate', root, '--json'], root);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.response.diagnostics.length, 1);
    assert.deepEqual(snapshot(root), before);
    const io = run(['check', path.join(root, 'absent'), '--json'], root);
    assert.equal(io.status, 1);
    assert.match(io.response.errors.join(' '), /ENOENT/);
    for (const args of [[], ['unknown'], ['generate', root, 'extra'], ['--unknown'],
        ['inspect', '--json'], ['check', '--help', '-h'], ['help', 'unknown']]) {
        const result = run([...args, '--json'], root);
        assert.equal(result.status, 2, JSON.stringify(args));
        assert.ok(result.response.errors.length);
    }
});

test('JSON help works without reading a project', t => {
    const root = fixture(t);
    for (const args of [['--help'], ['help'], ['inspect', '-h'], ['help', 'self-check']]) {
        const { response, status } = run([...args, '--json'], root);
        assert.equal(status, 0);
        assert.equal(response.command, 'help');
        assert.match(response.usage || '', /Usage:/);
    }
    assert.deepEqual(fs.readdirSync(root), []);
});

test('self-check rejects stale outputs before executing project code and rejects non-self-hosted layouts', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'index.literate'), source());
    const before = snapshot(root);
    const stale = run(['self-check', root, '--json'], root);
    assert.equal(stale.status, 1);
    assert.equal(stale.response.selfHosting, undefined);
    assert.deepEqual(snapshot(root), before);
    assert.equal(run(['generate', root, '--json'], root).status, 0);
    const current = snapshot(root);
    const unsupported = run(['self-check', root, '--json'], root);
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.response.selfHosting?.checks[0].name, 'layout');
    assert.equal(unsupported.response.selfHosting?.checks[0].ok, false);
    assert.deepEqual(snapshot(root), current);
});

test('CLI-only bootstrap succeeds without compiling broken extension source', t => {
    const root = fixture(t);
    const sourceRoot = path.resolve(__dirname, '../../../src');
    for (const name of ['cli.ts', 'engine.ts', 'self-hosting.ts']) {
        fs.copyFileSync(path.join(sourceRoot, name), path.join(root, name));
    }
    fs.writeFileSync(path.join(root, 'extension.ts'), 'this is not TypeScript');
    const executable = path.join(root, 'bootstrap.cjs');
    const esbuild = require.resolve('esbuild/bin/esbuild');
    const bundled = spawnSync(esbuild, [path.join(root, 'cli.ts'), '--bundle', '--platform=node', '--format=cjs',
        '--external:typescript', '--external:esbuild', '--external:markdown-it', '--external:highlight.js',
                '--outfile=' + executable, '--log-level=error'], {
        encoding: 'utf8', timeout: 15000,
        env: environment
    });
    assert.ifError(bundled.error);
    assert.equal(bundled.status, 0, bundled.stderr);
    const { status } = run(['--help', '--json'], root, executable);
    assert.equal(status, 0);
    const selfCheck = run(['self-check', path.resolve(sourceRoot, '..'), '--json'], root, executable);
    assert.equal(selfCheck.status, 0, JSON.stringify(selfCheck.response));
    assert.deepEqual(selfCheck.response.selfHosting?.checks.map(check => check.name),
        ['layout', 'typecheck', 'bundle', 'fixedpoint']);
});
