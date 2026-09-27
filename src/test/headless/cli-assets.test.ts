/* eslint-disable @typescript-eslint/naming-convention -- Manifest keys are case-sensitive font family names. */
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createTransactionIO, run } from '../../cli';
import { collectAssets, planAssets } from '../../publication-assets';
import { parseProject } from '../../engine';
import { LatexConverter } from '../../publication-latex';
import type { DiagramRenderer } from '../../publication-mermaid';

const png = Buffer.from('89504e470d0a1a0a00ff80', 'hex');
const source = '# Book\n\n![Figure](../images/a.png)\n\n![Repeated](../images/b.png)\n';
function write(root: string, name: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
}
function fixture(t: { after(callback: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate images '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'chapters/book.literate', source);
    write(root, 'images/a.png', png); write(root, 'images/b.png', png);
    return root;
}
function tree(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name), stat = fs.lstatSync(file);
        return [name, stat.isDirectory() ? null : stat.mtimeMs, stat.mode,
            stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? tree(file) : fs.readFileSync(file).toString('hex')];
    });
}
async function command(root: string, factory = createTransactionIO,
    converter: LatexConverter = async () => 'Body', flags: string[] = [], diagrams?: DiagramRenderer) {
    let stdout = '', calls = 0;
    const code = await run(['latex', root, '--output', 'books/book.tex', '--json', ...flags], {
        stdout: value => { stdout += value; }, stderr: value => assert.fail(value)
    }, factory, async (...args) => { calls++; return converter(...args); }, diagrams);
    const response = JSON.parse(stdout) as {
        errors: string[]; diagnostics: { message: string }[]; outputs: { path: string; status: string }[];
    };
    return { code, response, calls };
}
async function companion(): Promise<string> {
    const collected = collectAssets(parseProject([{ path: 'chapters/book.literate', text: source }]));
    const plan = await planAssets(collected.assets, 'books/book.tex', {
        async requireFile() {}, async read() { return png; }
    });
    return plan.files[0].path;
}
test('CLI packages binary companions once and preserves bytes and mtime on repetition', async t => {
    const root = fixture(t), result = await command(root);
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.equal(result.response.outputs.length, 2);
    assert.deepEqual(fs.readFileSync(path.join(root, await companion())), png);
    const before = tree(root), repeated = await command(root);
    assert.equal(repeated.code, 0);
    assert.ok(repeated.response.outputs.every(file => file.status === 'current'));
    assert.deepEqual(tree(root), before);
});
for (const fault of ['missing', 'symlink-file', 'symlink-directory', 'directory', 'oversized', 'signature', 'remote', 'query']) {
    test(`CLI rejects ${fault} before conversion and leaves the book intact`, async t => {
        const root = fixture(t);
        write(root, 'books/book.tex', 'previous book');
        const file = path.join(root, 'images/a.png');
        if (fault === 'missing' || fault === 'directory') { fs.unlinkSync(file); }
        if (fault === 'directory') { fs.mkdirSync(file); }
        if (fault === 'symlink-file') { fs.renameSync(file, file + '-real'); fs.symlinkSync(file + '-real', file); }
        if (fault === 'symlink-directory') {
            fs.renameSync(path.join(root, 'images'), path.join(root, 'real-images'));
            fs.symlinkSync(path.join(root, 'real-images'), path.join(root, 'images'));
        }
        if (fault === 'oversized') { fs.truncateSync(file, 32 * 1024 * 1024 + 1); }
        if (fault === 'signature') { fs.writeFileSync(file, 'not PNG'); }
        if (fault === 'remote' || fault === 'query') {
            write(root, 'chapters/book.literate', `![Bad](${fault === 'remote' ? 'https://example.org/a.png' : '../images/a.png?x'})`);
        }
        const before = tree(root), result = await command(root);
        assert.equal(result.code, 1); assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), /chapters\/book.literate:/);
        assert.deepEqual(tree(root), before);
    });
}
for (const input of ['images/a.png', 'chapters/book.literate', 'template.txt']) {
    test(`CLI rejects a companion hard-linked to input ${input}`, async t => {
        const root = fixture(t), output = await companion();
        if (input === 'template.txt') {
            write(root, input, 'template');
            fs.appendFileSync(path.join(root, 'chapters/book.literate'), '\n```text: <<main.*>>= generated.txt $ template=template.txt\nHello\n```\n');
        }
        fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
        fs.linkSync(path.join(root, input), path.join(root, output));
        const before = tree(root), result = await command(root);
        assert.equal(result.code, 1); assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), /aliases input/);
        assert.deepEqual(tree(root), before);
    });
}
test('converter failure preserves all existing assets and text', async t => {
    const root = fixture(t);
    write(root, 'books/book.tex', 'old book'); write(root, await companion(), 'old companion');
    const before = tree(root);
    const result = await command(root, createTransactionIO, async () => { throw new Error('converter failed'); });
    assert.equal(result.code, 1); assert.equal(result.calls, 1);
    assert.deepEqual(tree(root), before);
});
for (const existing of [false, true]) {
    test(`text, fonts and images roll back together after binary install (existing=${existing})`, async t => {
        const root = fixture(t), asset = await companion();
        write(root, 'index.literate', '```SETTINGS\nfont-body=Example\nfont-heading=Example\nfont-code=Example\nfont-fragment=Example\n```\n');
        write(root, 'font.ttf', Buffer.from([0, 255, 128, 1])); write(root, 'license.txt', 'license');
        write(root, 'fonts.json', JSON.stringify({ version: 1, families: { Example: {
            regular: 'font.ttf', bold: 'font.ttf', italic: 'font.ttf', boldItalic: 'font.ttf', licenses: ['license.txt']
        } } }));
        if (existing) {
            assert.equal((await command(root, createTransactionIO, undefined, ['--font-manifest', 'fonts.json'])).code, 0);
            write(root, 'books/book.tex', 'previous book'); write(root, asset, 'previous image');
            for (const file of fs.readdirSync(path.join(root, 'books')).filter(name => name.startsWith('lit-fonts-'))) {
                for (const face of fs.readdirSync(path.join(root, 'books', file))) { write(root, `books/${file}/${face}`, 'old font'); }
            }
        }
        const before = tree(root);
        let injected = false;
        const result = await command(root, directory => {
            const io = createTransactionIO(directory);
            return { ...io, async rename(from, to) {
                await io.rename(from, to);
                if (!injected && from.endsWith('.stage') && to === asset) {
                    injected = true; throw new Error('failure after image install');
                }
            } };
        }, undefined, ['--font-manifest', 'fonts.json']);
        assert.equal(injected, true); assert.equal(result.code, 1);
        assert.match(result.response.errors.join('\n'), /rolled_back/);
        assert.ok(result.response.outputs.every(file => file.status !== 'written'));
        assert.deepEqual(tree(root), before);
    });
}
const diagramSource = '\n```mermaid\ngraph TD; A-->B\n```\n';
const stubDiagrams: DiagramRenderer = async assets => new Map(assets.map(asset => [asset.source, {
    pdf: Buffer.from('%PDF-1.4\nstub diagram'), svg: Buffer.from('<svg></svg>')
}]));

for (const alias of ['external-symlink', 'hardlink', 'ancestor']) {
    test(`CLI protects the browser ${alias} before conversion without changing outputs`, async t => {
        const root = fixture(t), external = fixture(t);
        fs.appendFileSync(path.join(root, 'chapters/book.literate'), diagramSource);
        write(root, 'books/book.tex', 'previous book');
        const browser = path.join(external, 'browser');
        if (alias === 'external-symlink') {
            fs.symlinkSync(path.join(root, 'books/book.tex'), browser);
        } else if (alias === 'hardlink') {
            write(external, 'browser', 'browser executable');
            fs.unlinkSync(path.join(root, 'books/book.tex'));
            fs.linkSync(browser, path.join(root, 'books/book.tex'));
        } else {
            fs.unlinkSync(path.join(root, 'books/book.tex'));
            write(root, 'books/book.tex/browser', 'browser executable');
            fs.symlinkSync(path.join(root, 'books/book.tex/browser'), browser);
        }
        const before = tree(root), externalBefore = tree(external);
        const result = await command(root, createTransactionIO, undefined, ['--browser', browser], stubDiagrams);
        assert.equal(result.code, 1); assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), /conflicts with browser input|aliases input/);
        assert.deepEqual(tree(root), before);
        assert.deepEqual(tree(external), externalBefore);
    });
}

test('CLI accepts a trusted in-project browser symlink for Mermaid', async t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'chapters/book.literate'), diagramSource);
    write(root, 'tools/chromium', 'browser executable');
    const browser = path.join(root, 'tools/browser');
    fs.symlinkSync(path.join(root, 'tools/chromium'), browser);
    const before = tree(path.join(root, 'tools'));
    let renders = 0;
    const result = await command(root, createTransactionIO, undefined, ['--browser', browser], async (...args) => {
        renders++;
        assert.equal(args[2], browser);
        return stubDiagrams(...args);
    });
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.equal(result.calls, 1); assert.equal(renders, 1);
    assert.deepEqual(tree(path.join(root, 'tools')), before);
});

test('CLI does not look up a missing browser or render diagrams for an image-only book', async t => {
    const root = fixture(t);
    const result = await command(root, createTransactionIO, undefined,
        ['--browser', path.join(root, 'missing/browser')], async () => assert.fail('Unexpected browser renderer'));
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.equal(result.calls, 1);
});

test('Mermaid without an explicit browser is an actionable failure, never a silent omission', async t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'chapters/book.literate'), '\n```mermaid\ngraph TD; A-->B\n```\n');
    write(root, 'books/book.tex', 'previous book');
    const before = tree(root), result = await command(root);
    assert.equal(result.code, 1); assert.equal(result.calls, 0);
    assert.match(result.response.errors.join('\n'), /Mermaid requires --browser/);
    assert.deepEqual(tree(root), before);
});
