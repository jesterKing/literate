import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifySelfHosting } from '../../self-hosting';
import type { GeneratedFile } from '../../engine';

const engine = 'import { decode } from "./generated/decode.js";\n'
    + 'export function generateProject(documents: { text: string }[], templates: Record<string, string>) {\n'
    + 'return { files: decode(documents[0].text), diagnostics: decode(templates.diagnostics) };\n}\n';

function snapshot(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const absolute = path.join(root, name);
        const stat = fs.statSync(absolute);
        return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(absolute) : fs.readFileSync(absolute, 'utf8')];
    });
}

function fixture(t: { after(callback: () => void): void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-host fixture '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, target: 'es2020', module: 'commonjs', types: [], rootDir: 'src', outDir: 'out' },
        include: ['src/**/*.ts']
    }));
    // Deliberately stale disk sources must be replaced in both compiler and bundler.
    fs.writeFileSync(path.join(root, 'src/engine.ts'), 'invalid disk engine');
    fs.writeFileSync(path.join(root, 'src/cli.ts'), 'invalid disk CLI');
    const files: GeneratedFile[] = [
        { path: 'src/engine.ts', content: engine },
        { path: 'src/cli.ts', content: 'import { generateProject } from "./engine";\nexport const run = generateProject;\n' },
        { path: 'src/generated/decode.ts', content: 'export const decode = (text: string): unknown => JSON.parse(text);\n' },
        { path: 'book.html', content: '<p>Fixed point</p>\n' }
    ];
    const verify = async (settings: {
        regenerated?: GeneratedFile[]; diagnostics?: unknown[]; timeoutMs?: number;
    } = {}) => {
        const before = snapshot(root);
        try {
            return await verifySelfHosting(root,
                [{ path: 'fixture.literate', text: JSON.stringify(settings.regenerated ?? files) }],
                { diagnostics: JSON.stringify(settings.diagnostics ?? []) }, files,
                { timeoutMs: settings.timeoutMs });
        } finally {
            assert.deepEqual(snapshot(root), before, 'verification must not change project files or mtimes');
        }
    };
    return { root, files, verify };
}

function failed(result: Awaited<ReturnType<typeof verifySelfHosting>>, stage: string, message: RegExp) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.checks.map(check => [check.name, check.ok]),
        ['layout', 'typecheck', 'bundle', 'fixedpoint'].slice(0,
            ['layout', 'typecheck', 'bundle', 'fixedpoint'].indexOf(stage) + 1)
            .map(name => [name, name !== stage]));
    assert.match(result.checks[result.checks.length - 1].message ?? '', message);
}

test('fresh virtual sources beat stale TypeScript and outputs compare independent of order', async t => {
    const { files, verify } = fixture(t);
    const result = await verify({ regenerated: [...files].reverse() });
    assert.deepEqual(result, { ok: true, checks: ['layout', 'typecheck', 'bundle', 'fixedpoint']
        .map(name => ({ name, ok: true })) });
});

for (const resolution of ['sibling file', 'directory package entry']) {
    test(`fresh bundling preserves normal precedence for a ${resolution}`, async t => {
        const { root, files, verify } = fixture(t);
        files[0].content = 'import { mode } from "./helper";\n'
            + 'export function generateProject(documents: {text: string}[]) {\n'
            + 'return { files: mode ? JSON.parse(documents[0].text) : [], diagnostics: [] };\n}\n';
        files.push({ path: 'src/helper/index.ts', content: 'export const mode = true;\n' });
        if (resolution === 'sibling file') {
            fs.writeFileSync(path.join(root, 'src/helper.ts'), 'export const mode = false;\n');
        } else {
            fs.mkdirSync(path.join(root, 'src/helper'));
            fs.writeFileSync(path.join(root, 'src/helper/package.json'), '{"main":"entry.ts"}');
            fs.writeFileSync(path.join(root, 'src/helper/entry.ts'), 'export const mode = false;\n');
        }
        failed(await verify(), 'fixedpoint', /Missing regenerated output/);
    });
}

test('invalid fresh CLI types fail before bundling', async t => {
    const { files, verify } = fixture(t);
    files[1].content = 'export const invalid: number = "wrong";\n';
    failed(await verify(), 'typecheck', /src\/cli\.ts:1:\d+: TS2322/);
});

test('existing included sources participate in the no-emit typecheck', async t => {
    const { root, verify } = fixture(t);
    fs.writeFileSync(path.join(root, 'src/existing.test.ts'), 'const invalid: number = "wrong";\n');
    failed(await verify(), 'typecheck', /existing\.test\.ts.*TS2322/);
});

for (const required of ['src/engine.ts', 'src/cli.ts']) {
    test(`missing generated layout: ${required}`, async t => {
        const { files, verify } = fixture(t);
        files.splice(files.findIndex(file => file.path === required), 1);
        failed(await verify(), 'layout', /Missing generated src\/(engine|cli)\.ts/);
    });
}

for (const kind of ['changed', 'missing', 'extra'] as const) {
    test(`fixed point rejects ${kind} outputs`, async t => {
        const { files, verify } = fixture(t);
        const regenerated = files.map(file => ({ ...file }));
        if (kind === 'changed') { regenerated[3].content += 'changed'; }
        if (kind === 'missing') { regenerated.pop(); }
        if (kind === 'extra') { regenerated.push({ path: 'extra.txt', content: 'extra' }); }
        failed(await verify({ regenerated }), 'fixedpoint', {
            changed: /Regenerated content mismatch: book\.html/,
            missing: /Missing regenerated output: book\.html/,
            extra: /Unexpected regenerated output: extra\.txt/
        }[kind]);
    });
}

test('generator diagnostics invalidate otherwise identical output', async t => {
    const { verify } = fixture(t);
    failed(await verify({ diagnostics: [{ message: 'generation failed' }] }),
        'fixedpoint', /Regenerated engine diagnostics:.*generation failed/);
});

for (const [name, source, message] of [
    ['invalid JSON', 'console.log("not JSON"); return { files: [], diagnostics: [] };', /JSON|Unexpected token/],
    ['throwing engine', 'throw new Error("engine exploded");', /Engine child failed:.*engine exploded/s],
    ['invalid result', 'return { files: null, diagnostics: [] };', /Invalid engine result/],
    ['invalid output', 'return { files: [{ path: "x", content: 7 }], diagnostics: [] };', /Invalid or duplicate/],
    ['duplicate output', 'return { files: [{ path: "x", content: "" }, { path: "x", content: "" }], diagnostics: [] };', /Invalid or duplicate/]
] as const) {
    test(`fixed point reports ${name}`, async t => {
        const { files, verify } = fixture(t);
        files[0].content = `declare const console: { log(text: string): void };\nexport function generateProject() { ${source} }\n`;
        failed(await verify(), 'fixedpoint', message);
    });
}

test('short timeout terminates a synchronous infinite loop', async t => {
    const { files, verify } = fixture(t);
    files[0].content = 'export function generateProject() { while (true) {} }\n';
    failed(await verify({ timeoutMs: 25 }), 'fixedpoint', /timed out or was killed \(25 ms limit\)/);
});

for (const [name, output, message] of [
    ['escaping', { path: '../escape.ts', content: '' }, /Output outside project/],
    ['duplicate', { path: 'src/cli.ts', content: '' }, /Duplicate output/]
] as const) {
    test(`layout rejects ${name} output`, async t => {
        const { files, verify } = fixture(t);
        files.push(output);
        failed(await verify(), 'layout', message);
    });
}

test('invalid tsconfig is a typecheck failure', async t => {
    const { root, verify } = fixture(t);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{ invalid');
    failed(await verify(), 'typecheck', /TS\d+/);
});

test('timeout must be positive and finite', async t => {
    const { verify } = fixture(t);
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
        failed(await verify({ timeoutMs }), 'layout', /timeoutMs must be positive and finite/);
    }
});
