import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createTransactionIO, run } from '../../cli';
import { LatexConverter } from '../../publication-latex';

interface Response {
    schemaVersion: number;
    command: string;
    ok: boolean;
    root?: string;
    diagnostics: { path: string; line: number; column: number; code: string; message: string }[];
    errors: string[];
    outputs: { path: string; status: string }[];
    usage?: string;
}
const cli = path.resolve(__dirname, '../../cli.js');
const body = '\\chapter{Converted book}\nBody from converter.\n';
const convert: LatexConverter = async () => body;
const source = '# A book\n\n```text: <<main.*>>= generated.txt $\nhello\n```\n';

function fixture(t: { after(callback: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate latex '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function write(root: string, name: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
}
function snapshot(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        return [name, stat.mtimeMs, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(file)
            : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file, 'utf8')];
    });
}
function parseResponse(stdout: string, stderr: string, code: number | null): Response {
    assert.equal(stderr, '', 'JSON mode must not emit stderr logging');
    const response: Response = JSON.parse(stdout);
    assert.equal(response.schemaVersion, 1);
    assert.equal(response.ok, code === 0);
    assert.ok(Array.isArray(response.diagnostics));
    assert.ok(Array.isArray(response.errors));
    assert.ok(Array.isArray(response.outputs));
    return response;
}
async function command(args: string[], converter = convert, factory = createTransactionIO) {
    let stdout = '', stderr = '';
    const code = await run([...args, '--json'], {
        stdout: text => { stdout += text; }, stderr: text => { stderr += text; }
    }, factory, converter);
    return { code, response: parseResponse(stdout, stderr, code) };
}
const latex = (root: string, output = 'books/book.tex') => ['latex', root, '--output', output];
function failureText(response: Response): string {
    return [...response.errors, ...response.diagnostics.map(diagnostic => diagnostic.message)].join('\n');
}

const invalidArguments: string[][] = [
    [], ['--output'], ['--output', ''], ['--output', '../escape.tex'],
    ['--output', '/absolute.tex'], ['--output', 'C:\\absolute.tex'],
    ['--output', 'book.pdf'], ['--output', 'book.html'], ['--output', 'book.TEX'],
    ['--output=book.tex'], ['--output', 'book.tex', '--output', 'other.tex'],
    ...['A4', 'a3', 'unknown'].map(paper => ['--output', 'book.tex', '--paper', paper]),
    ...['', '4mm', '50.1mm', '-5mm', 'NaNmm', 'Infinitymm', '2cm', '20', '20mm;touch x'].map(margin =>
        ['--output', 'book.tex', '--margin', margin]),
    ['--output', 'book.tex', '--paper', 'a5', '--margin', '34.1mm'],
    ['--output', 'book.tex', '--paper'], ['--output', 'book.tex', '--margin'],
    ['--output', 'book.tex', '--margin', '20mm', '--margin', '10mm']
];
for (const args of invalidArguments) {
    test(`latex rejects invalid usage before discovery/conversion: ${JSON.stringify(args)}`, async t => {
        const root = fixture(t);
        let calls = 0;
        const result = await command(['latex', path.join(root, 'not-a-project'), ...args], async () => {
            calls++; return body;
        });
        assert.equal(result.code, 2);
        assert.equal(calls, 0);
        assert.ok(result.response.errors.length);
        assert.doesNotMatch(failureText(result.response), /ENOENT/);
        assert.deepEqual(result.response.outputs, []);
        assert.deepEqual(fs.readdirSync(root), []);
    });
}
for (const name of ['generate', 'check', 'inspect', 'self-check']) {
    test(`${name} rejects all latex-only options, including help`, async t => {
        const root = fixture(t);
        for (const option of [['--output', 'book.tex'], ['--paper', 'a4'], ['--margin', '20mm'],
                    ...['top', 'right', 'bottom', 'left'].map(side => ['--margin-' + side, '20mm'])]) {
            for (const help of [[], ['--help']]) {
                let calls = 0;
                const result = await command([name, path.join(root, 'absent'), ...option, ...help], async () => {
                    calls++; return body;
                });
                assert.equal(result.code, 2);
                assert.equal(calls, 0);
                assert.deepEqual(result.response.outputs, []);
            }
        }
    });
}

test('latex uses the root theme and ignores chapter-local theme settings', async t => {
    const root = fixture(t);
    write(root, 'index.literate', '```SETTINGS\ntheme=hermonica\n```\n' + source);
    write(root, 'chapter.literate', '```SETTINGS\ntheme=not-a-theme\n```\n');
    const result = await command(latex(root));
    assert.equal(result.code, 0, failureText(result.response));
    assert.ok(fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8')
        .includes('\\definecolor{publicationBackground}{HTML}{0a0d10}'));
});

test('latex invalid root theme preserves output and never invokes Pandoc', async t => {
    const root = fixture(t);
    write(root, 'index.literate', '```SETTINGS\ntheme=not-a-theme\n```\n' + source);
    write(root, 'books/book.tex', 'previous book');
    const before = snapshot(root);
    let calls = 0;
    const result = await command(latex(root), async () => { calls++; return body; });
    assert.equal(result.code, 1);
    assert.equal(calls, 0);
    assert.equal(result.response.diagnostics[0].message, 'Unknown theme: not-a-theme');
    assert.deepEqual(snapshot(root), before);
});

test('latex help needs no output or converter', async () => {
    let calls = 0;
    const result = await command(['latex', '--help'], async () => { calls++; return body; });
    assert.equal(result.code, 0);
    assert.equal(result.response.command, 'help');
    assert.match(result.response.usage || '', /--output.*--paper.*--margin/);
    assert.equal(calls, 0);
});

for (const [paper, margin] of [['a4', '50mm'], ['a5', '34mm'], ['letter', '5mm'], ['legal', '20.5mm']]) {
    test(`latex accepts ${paper}/${margin} and passes geometry to the book`, async t => {
        const root = fixture(t);
        write(root, 'index.literate', source);
        const result = await command([...latex(root), '--paper', paper, '--margin', margin]);
        assert.equal(result.code, 0, failureText(result.response));
        const tex = fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8');
        assert.ok(tex.includes(`${paper}paper,margin=${margin}`));
    });
}

test('latex applies asymmetric CLI margins with uniform fallback and root font settings', async t => {
    const root = fixture(t);
    write(root, 'index.literate', '```SETTINGS\nfont-body=Body Font\nfont-heading=Heading Font\n'
        + 'font-code=Code Font\nfont-fragment=Fragment Font\nfont-note=Note Font\nfont-code-ligatures=off\n```\n' + source);
    write(root, 'chapter.literate', '```SETTINGS\nfont-code=bad/path\n```\n');
    const result = await command([...latex(root), '--paper', 'a5', '--margin', '22mm',
        '--margin-top', '18mm', '--margin-left', '20mm', '--margin-right', '16mm']);
    assert.equal(result.code, 0, failureText(result.response));
    const tex = fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8');
    for (const value of ['a5paper,top=18mm,right=16mm,bottom=22mm,left=20mm',
        'Body Font', 'Heading Font', 'Code Font', 'Fragment Font', 'Note Font', 'RawFeature={-calt}']) {
        assert.ok(tex.includes(value), value);
    }
});

test('latex invalid font setting preserves output even when followed by a valid repeated value', async t => {
    const root = fixture(t);
    write(root, 'index.literate', '```SETTINGS\nfont-code=bad/path\nfont-code=Safe Font\n```\n' + source);
    write(root, 'books/book.tex', 'previous book');
    const before = snapshot(root);
    let calls = 0;
    const result = await command(latex(root), async () => { calls++; return body; });
    assert.equal(result.code, 1);
    assert.equal(calls, 0);
    assert.match(result.response.diagnostics[0].message, /Invalid font-code/);
    assert.equal(result.response.diagnostics[0].line, 1);
    assert.deepEqual(snapshot(root), before);
});

for (const side of ['top', 'right', 'bottom', 'left']) {
    test(`latex validates ${side} margin before discovery or conversion`, async t => {
        const root = fixture(t);
        for (const args of [[`--margin-${side}`], [`--margin-${side}`, 'NaNmm'],
            [`--margin-${side}`, '4mm'], [`--margin-${side}`, '51mm'], [`--margin-${side}`, '2cm'],
            [`--margin-${side}`, '20mm', `--margin-${side}`, '21mm']]) {
            let calls = 0;
            const result = await command([...latex(path.join(root, 'absent')), ...args], async () => {
                calls++; return body;
            });
            assert.equal(result.code, 2, JSON.stringify(args));
            assert.equal(calls, 0);
            assert.doesNotMatch(failureText(result.response), /ENOENT/);
        }
    });
}

test('latex validates effective margin sums rather than rejecting overridden A5 defaults', async t => {
    const root = fixture(t);
    write(root, 'index.literate', source);
    const valid = await command([...latex(root), '--paper', 'a5', '--margin', '50mm',
        '--margin-left', '18mm']);
    assert.equal(valid.code, 0, failureText(valid.response));
    const before = snapshot(root);
    const invalid = await command([...latex(root), '--paper', 'a5', '--margin-left', '34mm', '--margin-right', '34.1mm']);
    assert.equal(invalid.code, 2);
    assert.deepEqual(snapshot(root), before);
});

test('latex JSON writes only the selected-root book and preserves identical bytes and mtime', async t => {
    const base = fixture(t);
    const root = path.join(base, 'selected project');
    write(root, 'chapters/intro.literate', source);
    let calls = 0;
    const converter: LatexConverter = async (document, options) => {
        calls++;
        assert.ok(document.blocks.length);
        assert.deepEqual(options, { standalone: false, syntaxHighlighting: 'none', topLevelDivision: 'chapter' });
        return body;
    };
    const first = await command(latex(root), converter);
    assert.equal(first.code, 0, failureText(first.response));
    assert.equal(first.response.command, 'latex');
    assert.equal(first.response.root, fs.realpathSync(root));
    assert.deepEqual(first.response.diagnostics, []);
    assert.deepEqual(first.response.errors, []);
    assert.deepEqual(first.response.outputs, [{ path: 'books/book.tex', status: 'written' }]);
    const output = path.join(root, 'books/book.tex');
    const tex = fs.readFileSync(output, 'utf8');
    assert.ok(tex.includes(body));
    assert.ok(tex.includes('a4paper,margin=20mm'));
    assert.match(tex, /\\begin\{document\}/);
    assert.match(tex, /\\end\{document\}/);
    // An old, deliberate timestamp catches rewrites even on coarse-resolution filesystems.
    fs.utimesSync(output, new Date('2001-01-01'), new Date('2001-01-01'));
    const before = snapshot(base);
    const stat = fs.statSync(output);
    const second = await command(latex(root), converter);
    assert.equal(second.code, 0);
    assert.deepEqual(second.response.outputs, [{ path: 'books/book.tex', status: 'current' }]);
    assert.equal(calls, 2);
    assert.equal(fs.statSync(output).ino, stat.ino);
    assert.deepEqual(snapshot(base), before);
    assert.deepEqual(fs.readdirSync(base), ['selected project']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['books', 'chapters']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'chapters')), ['intro.literate']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'books')), ['book.tex']);
});

for (const [name, text] of [
    ['syntax', '```text: <<broken>>\nmalformed header\n```\n'],
    ['Mermaid', '```mermaid\ngraph TD; A-->B\n```\n']
]) {
    test(`latex ${name} diagnostics prevent conversion and all writes`, async t => {
        const root = fixture(t);
        write(root, 'index.literate', text);
        const before = snapshot(root);
        let calls = 0;
        const result = await command(latex(root), async () => { calls++; return body; });
        assert.equal(result.code, 1);
        assert.equal(calls, 0);
        assert.ok(result.response.diagnostics.length);
        assert.equal(result.response.diagnostics[0].path, 'index.literate');
        assert.deepEqual(result.response.outputs, []);
        assert.deepEqual(snapshot(root), before);
    });
}

test('latex converter rejection leaves an existing book and all inputs untouched', async t => {
    const root = fixture(t);
    write(root, 'index.literate', source);
    write(root, 'books/book.tex', 'previous book');
    const before = snapshot(root);
    let calls = 0;
    const result = await command(latex(root), async () => { calls++; throw new Error('injected converter failure'); });
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
    assert.match(failureText(result.response), /injected converter failure/);
    assert.deepEqual(result.response.outputs, []);
    assert.deepEqual(snapshot(root), before);
});

for (const [name, input, output, template] of [
    ['source ancestor', 'book.tex/chapter.literate', 'book.tex', false],
    ['source descendant', 'index.literate', 'index.literate/book.tex', false],
    ['source case alias ancestor', 'Book.TeX/chapter.literate', 'book.tex', false],
    ['source case alias descendant', 'index.literate', 'INDEX.LITERATE/book.tex', false],
    ['template equality', 'book.tex', 'book.tex', true],
    ['template case alias', 'Book.TeX', 'book.tex', true],
    ['template ancestor', 'book.tex/page.template', 'book.tex', true],
    ['template descendant', 'page.template', 'page.template/book.tex', true],
    ['template case alias descendant', 'Page.Template', 'page.template/book.tex', true]
] as const) {
    test(`latex rejects ${name} before conversion, including missing templates`, async t => {
        const root = fixture(t);
        if (template) {
            write(root, 'index.literate', `\`\`\`SETTINGS\ntemplate=${input}\n\`\`\`\n` + source);
        } else { write(root, input, source); }
        const before = snapshot(root);
        let calls = 0;
        const result = await command(latex(root, output), async () => { calls++; return body; });
        assert.equal(result.code, 1);
        assert.equal(calls, 0);
        assert.match(failureText(result.response), /conflict/i);
        assert.deepEqual(result.response.outputs, []);
        assert.deepEqual(snapshot(root), before);
    });
}

for (const kind of ['file', 'directory', 'dangling'] as const) {
    test(`latex rejects ${kind} output symlinks without touching their targets`, { skip: process.platform === 'win32' }, async t => {
        const base = fixture(t);
        const root = path.join(base, 'project');
        write(root, 'index.literate', source);
        write(base, 'outside/keep.tex', 'outside bytes');
        const link = kind === 'directory' ? 'books' : 'book.tex';
        const target = path.join(base, kind === 'directory' ? 'outside' : kind === 'file' ? 'outside/keep.tex' : 'missing');
        fs.symlinkSync(target, path.join(root, link));
        const before = snapshot(base);
        let calls = 0;
        const result = await command(latex(root, kind === 'directory' ? 'books/book.tex' : 'book.tex'), async () => {
            calls++; return body;
        });
        assert.equal(result.code, 1);
        assert.equal(calls, 0);
        assert.match(failureText(result.response), /link/i);
        assert.deepEqual(result.response.outputs, []);
        assert.deepEqual(snapshot(base), before);
    });
}

for (const existing of [false, true]) {
    test(`latex rolls back rename-after-effect with ${existing ? 'an existing' : 'a new'} book and never reports written`, async t => {
        const root = fixture(t);
        write(root, 'index.literate', source);
        if (existing) {
            write(root, 'books/book.tex', 'previous book');
            fs.chmodSync(path.join(root, 'books/book.tex'), 0o640);
        }
        const before = snapshot(root);
        const beforeBooks = existing ? snapshot(path.join(root, 'books')) : undefined;
        let injected = false;
        const result = await command(latex(root), convert, directory => {
            const io = createTransactionIO(directory);
            return { ...io, async rename(from, to) {
                await io.rename(from, to);
                if (!injected && from.endsWith('.stage') && to === 'books/book.tex') {
                    injected = true;
                    throw new Error('injected after install');
                }
            } };
        });
        assert.equal(injected, true);
        assert.equal(result.code, 1);
        assert.match(failureText(result.response), /rolled_back/);
        assert.ok(result.response.outputs.every(output => output.status !== 'written'));
        // Directory timestamps may change during staging; file bytes, mode and mtime must survive.
        if (existing) {
            assert.deepEqual(snapshot(path.join(root, 'books')), beforeBooks);
            assert.deepEqual(fs.readdirSync(root).sort(), ['books', 'index.literate']);
        } else { assert.deepEqual(snapshot(root), before); }
    });
}

// PATH belongs only to this subprocess: parallel tests never change the parent environment.
// The absolute Node shebang also works when fakebin is the child's entire PATH.
function pandocChild(root: string, program?: string) {
    const bin = path.join(root, 'fakebin');
    fs.mkdirSync(bin);
    if (program !== undefined) {
        write(bin, 'pandoc', `#!${process.execPath}\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => { input += chunk; });\nprocess.stdin.on('end', () => {\n${program}\n});\n`);
        fs.chmodSync(path.join(bin, 'pandoc'), 0o755);
    }
    const document = { ['pandoc-api-version']: [1, 23, 1], meta: {}, blocks: [{ t: 'Para', c: [{ t: 'Str', c: 'stdin sentinel' }] }] };
    const script = `const { runPandoc } = require(${JSON.stringify(cli)});
        runPandoc(${JSON.stringify(document)}, { standalone: false, syntaxHighlighting: 'none', topLevelDivision: 'chapter' })
        .then(body => console.log(JSON.stringify({ ok: true, body })),
            error => console.log(JSON.stringify({ ok: false, error: error.message })));`;
    const child = spawnSync(process.execPath, ['-e', script], {
        cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ['PATH']: bin }
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout) as { ok: boolean; body?: string; error?: string };
}

test('runPandoc reports missing executable with installation guidance in an isolated PATH', t => {
    const result = pandocChild(fixture(t));
    assert.equal(result.ok, false);
    assert.match(result.error || '', /Pandoc.*not found.*install Pandoc.*PATH/i);
});

test('runPandoc sends JSON on stdin and only fixed body-conversion argv', { skip: process.platform === 'win32' }, t => {
    const root = fixture(t);
    const result = pandocChild(root,
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: JSON.parse(input) }));');
    assert.equal(result.ok, true, result.error);
    const received = JSON.parse(result.body!);
    assert.deepEqual(received.argv, ['--from=json', '--to=latex', '--top-level-division=chapter', '--no-highlight']);
    assert.deepEqual(received.input, {
        ['pandoc-api-version']: [1, 23, 1], meta: {}, blocks: [{ t: 'Para', c: [{ t: 'Str', c: 'stdin sentinel' }] }]
    });
});

for (const [name, program, message] of [
    ['nonzero exit', "process.stderr.write('\\x1b[31mbad\\x1b[0m\\ninput\\x00'); process.exitCode = 1;", /exit 1.*bad input/],
    ['empty stdout', '', /empty.*body/i],
    ['signal exit', "process.kill(process.pid, 'SIGTERM');", /signal SIGTERM/],
    ['stdout limit', "process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 120));", /stdout exceeded 16 MiB/],
    ['stderr limit', "process.stderr.write(Buffer.alloc(64 * 1024 + 1, 120));", /stderr exceeded 64 KiB/]
] as const) {
    test(`runPandoc rejects ${name} promptly in a child sandbox`, { skip: process.platform === 'win32' }, t => {
        const result = pandocChild(fixture(t), program);
        assert.equal(result.ok, false);
        assert.match(result.error || '', message);
        assert.ok((result.error || '').length < 2300, 'stderr diagnostics must remain bounded');
        assert.doesNotMatch(result.error || '', /[\u0000-\u001f\u007f]/);
    });
}

function failingConverterProcess(root: string, program: string, timeout: number) {
    const bin = path.join(root, 'fakebin');
    write(bin, 'pandoc', `#!${process.execPath}\n${program}\n`);
    fs.chmodSync(path.join(bin, 'pandoc'), 0o755);
    write(root, 'index.literate', '# Large input\n\n' + 'x'.repeat(2 * 1024 * 1024));
    write(root, 'books/book.tex', 'previous book');
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [cli, ...latex(root), '--json'], {
        cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
        env: { ...process.env, ['PATH']: bin }
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 1);
    const response = parseResponse(child.stdout, child.stderr, child.status);
    assert.deepEqual(response.outputs, []);
    assert.deepEqual(snapshot(root), before);
    return response;
}

test('early Pandoc rejection during large stdin delivery retains exit details and existing output', {
    skip: process.platform === 'win32'
}, t => {
    const result = failingConverterProcess(fixture(t),
        "process.stderr.write('early rejection'); process.exit(7);", 10000);
    assert.match(failureText(result), /exit 7.*early rejection/);
});

for (const [name, program] of [
    ['blocked stdin', 'setInterval(() => {}, 1000);'],
    ['inherited pipes', "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 32000)'], { stdio: ['ignore', 1, 2] }).unref(); process.exit(0);"]
]) {
    test(`Pandoc deadline handles ${name} without changing output`, {
        skip: process.platform === 'win32' || process.env.LITERATE_TEST_PANDOC_LIFECYCLE !== '1'
    }, t => {
        const result = failingConverterProcess(fixture(t), program, 40000);
        assert.match(failureText(result), /timed out after 30000 ms/);
    });
}

test('optional real Pandoc CLI exports a nested sample without generating source or HTML', {
    skip: process.env.LITERATE_TEST_PANDOC !== '1'
}, t => {
    const base = fixture(t);
    const root = path.join(base, 'project');
    write(root, 'chapters/intro.literate', source);
    const child = spawnSync(process.execPath, [cli, ...latex(root), '--json'], {
        cwd: base, encoding: 'utf8', timeout: 40000, env: { ...process.env }
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    const response = parseResponse(child.stdout, child.stderr, child.status);
    assert.equal(child.status, 0, failureText(response));
    assert.deepEqual(response.outputs, [{ path: 'books/book.tex', status: 'written' }]);
    const tex = fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8');
    assert.match(tex, /\\begin\{document\}/);
    assert.match(tex, /A\s+book/);
    assert.match(tex, /hello/);
    assert.deepEqual(fs.readdirSync(base), ['project']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['books', 'chapters']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'chapters')), ['intro.literate']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'books')), ['book.tex']);
});
