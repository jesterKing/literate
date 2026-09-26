/* eslint-disable @typescript-eslint/naming-convention -- Manifest dictionary keys are case-sensitive font family names. */
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createTransactionIO, run } from '../../cli';
import { checkFontFace, fontFaces, planFonts, PortableFont } from '../../publication-fonts';
import { parseProject } from '../../engine';
import { renderLatex } from '../../publication-latex';

const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 1, 0]);
const source = '```SETTINGS\nfont-body=Example\nfont-heading=Example\nfont-code=Example\nfont-fragment=Example\n```\n# Book\n';
const entry = () => ({ regular: 'inputs/r.ttf', bold: 'inputs/b.otf', italic: 'inputs/i.ttf',
    boldItalic: 'inputs/bi.otf', licenses: ['inputs/license.txt'] });
const manifest = () => ({ version: 1, families: { Example: entry(), Unselected: entry() } });
function write(root: string, name: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
}
function fixture(t: { after(callback: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate fonts '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'index.literate', source);
    write(root, 'config/fonts.json', JSON.stringify(manifest()));
    for (const [index, file] of [...fontFaces.map(face => entry()[face]), 'inputs/license.txt'].entries()) {
        write(root, file, Buffer.concat([bytes, Buffer.from([index])]));
    }
    return root;
}
async function command(root: string, factory = createTransactionIO, output = 'books/book.tex',
    manifestPath = 'config/fonts.json') {
    let stdout = '', calls = 0;
    const code = await run(['latex', root, '--output', output, '--font-manifest', manifestPath, '--json'], {
        stdout: text => { stdout += text; }, stderr: text => assert.fail(text)
    }, factory, async () => { calls++; return 'Book body'; });
    const response = JSON.parse(stdout) as { errors: string[]; outputs: { path: string; status: string }[] };
    return { code, response, calls };
}
function tree(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name), stat = fs.lstatSync(file);
        return [name, stat.isDirectory() ? null : stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file)
            : stat.isDirectory() ? tree(file) : fs.readFileSync(file).toString('hex')];
    });
}
test('portable CLI preserves binary bytes, emits only selected families and is repeatable', async t => {
    const root = fixture(t);
    const first = await command(root);
    assert.equal(first.code, 0, first.response.errors.join('\n'));
    assert.equal(first.calls, 1);
    assert.equal(first.response.outputs.length, 6);
    const tex = fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8');
    assert.doesNotMatch(tex, /inputs\/|Example|Unselected|FakeSlant|FakeBold/);
    const directory = /Path=\{(lit-fonts-[a-f0-9]{64}\/)\}/.exec(tex)![1];
    for (const [index, face] of fontFaces.entries()) {
        const option = face === 'regular' ? /\]\{([a-f0-9]{64}\.(?:ttf|otf))\}/ :
            new RegExp(`${face === 'boldItalic' ? 'BoldItalic' : face === 'bold' ? 'Bold' : 'Italic'}Font=\\{([^}]+)\\}`);
        const name = directory + option.exec(tex)![1];
        assert.match(name, /^lit-fonts-[a-f0-9]{64}\/[a-f0-9]{64}\.(ttf|otf)$/);
        assert.deepEqual(fs.readFileSync(path.join(root, 'books', name)), Buffer.concat([bytes, Buffer.from([index])]));
    }
    const license = first.response.outputs.find(file => file.path.endsWith('.license.txt'))!;
    assert.deepEqual(fs.readFileSync(path.join(root, license.path)), Buffer.concat([bytes, Buffer.from([4])]));
    const before = tree(root);
    const second = await command(root);
    assert.equal(second.code, 0);
    assert.ok(second.response.outputs.every(file => file.status === 'current'));
    assert.deepEqual(tree(root), before);
});
const invalid: [string, unknown, RegExp][] = [
    ['version', { ...manifest(), version: 2 }, /version must be 1/],
    ['array', [], /JSON object/],
    ['extra top field', { ...manifest(), discovery: true }, /unknown field discovery/],
    ['missing selected family', { version: 1, families: {} }, /selected family "Example" is missing/],
    ['missing face', { version: 1, families: { Example: { ...entry(), italic: undefined } } }, /italic.*root-relative/],
    ['unknown face', { version: 1, families: { Example: { ...entry(), bolditalic: 'inputs/bi.otf' } } }, /unknown field bolditalic/],
    ['empty licenses', { version: 1, families: { Example: { ...entry(), licenses: [] } } }, /nonempty array/],
    ['wrong licenses', { version: 1, families: { Example: { ...entry(), licenses: 'inputs/license.txt' } } }, /nonempty array/],
    ['unsupported format', { version: 1, families: { Example: { ...entry(), regular: 'inputs/r.woff' } } }, /ttf or .otf/],
    ...['../r.ttf', '/tmp/r.ttf', 'C:\\r.ttf', 'x\u0000.ttf'].map(value =>
        [`unsafe ${value}`, { version: 1, families: { Example: { ...entry(), regular: value } } }, /root-relative/] as [string, unknown, RegExp]),
    ['missing unselected input', { version: 1, families: { Example: entry(), Other: { ...entry(), regular: 'absent.ttf' } } }, /absent.ttf.*Missing file/]
];
for (const [name, value, error] of invalid) {
    test(`manifest rejects ${name} before conversion or output`, async t => {
        const root = fixture(t);
        write(root, 'config/fonts.json', JSON.stringify(value));
        write(root, 'books/book.tex', 'old');
        const before = tree(root), result = await command(root);
        assert.equal(result.code, 1);
        assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), error);
        assert.deepEqual(tree(root), before);
    });
}
for (const name of ['config/fonts.json', 'inputs/r.ttf', 'inputs/license.txt', 'inputs']) {
    test(`manifest rejects symlink at ${name}`, async t => {
        const root = fixture(t), target = path.join(root, name);
        fs.renameSync(target, target + '-real');
        fs.symlinkSync(target + '-real', target);
        const before = tree(root), result = await command(root);
        assert.equal(result.code, 1);
        assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), /Symbolic link/);
        assert.deepEqual(tree(root), before);
    });
}
for (const name of ['config/fonts.json', 'inputs/r.ttf', 'inputs/license.txt']) {
    for (const kind of ['missing', 'directory']) {
        test(`manifest rejects ${kind} ${name}`, async t => {
            const root = fixture(t), target = path.join(root, name);
            fs.unlinkSync(target);
            if (kind === 'directory') { fs.mkdirSync(target); }
            const result = await command(root);
            assert.equal(result.code, 1);
            assert.equal(result.calls, 0);
            assert.match(result.response.errors.join('\n'), /Missing file|not a regular file/);
        });
    }
}
test('invalid JSON is contextual and no flag leaves family mode unchanged', async t => {
    const root = fixture(t);
    write(root, 'config/fonts.json', '{broken');
    const failed = await command(root);
    assert.match(failed.response.errors.join('\n'), /Font manifest config\/fonts.json: cannot read JSON/);
    const code = await run(['latex', root, '--output', 'book.tex'], { stdout() {}, stderr: assert.fail },
        createTransactionIO, async () => 'body');
    assert.equal(code, 0);
    assert.match(fs.readFileSync(path.join(root, 'book.tex'), 'utf8'), /\\setmainfont\{Example\}/);
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('lit-fonts-')));
});
test('manifest and selected/unselected license paths cannot collide with tex output', async t => {
    for (const kind of ['manifest', 'selected', 'unselected', 'case-alias', 'ancestor']) {
        const root = fixture(t), data = manifest();
        let manifestPath = 'config/fonts.json';
        if (kind === 'manifest') { manifestPath = 'books/book.tex'; }
        else {
            const name = kind === 'case-alias' ? 'books/BOOK.tex' : kind === 'ancestor' ? 'books/book.tex/license' : 'books/book.tex';
            data.families[kind === 'selected' ? 'Example' : 'Unselected'].licenses = [name];
            write(root, name, 'license');
        }
        write(root, manifestPath, JSON.stringify(data));
        const before = tree(root), result = await command(root, createTransactionIO, 'books/book.tex', manifestPath);
        assert.equal(result.code, 1);
        assert.equal(result.calls, 0);
        assert.match(result.response.errors.join('\n'), /conflicts with input/);
        assert.deepEqual(tree(root), before);
    }
});
test('companion outputs protect font, license, manifest, source and template inputs', async t => {
    for (const kind of ['font', 'license', 'manifest', 'template', 'source']) {
        const root = fixture(t);
        const success = await command(root);
        const target = success.response.outputs.find(file => file.path.endsWith('.ttf'))!.path;
        const data = manifest();
        let manifestPath = 'config/fonts.json';
        if (kind === 'font') { data.families.Unselected.regular = target; }
        if (kind === 'license') { data.families.Unselected.licenses = [target]; }
        if (kind === 'manifest') { manifestPath = target; }
        if (kind === 'template') { write(root, 'index.literate', source + `\n\`\`\`SETTINGS\ntemplate=${target}\n\`\`\`\n`); }
        if (kind === 'source') {
            fs.unlinkSync(path.join(root, target));
            write(root, target + '/hidden.literate', '# Protected');
        }
        write(root, manifestPath, JSON.stringify(data));
        const before = tree(root), failed = await command(root, createTransactionIO, 'books/book.tex', manifestPath);
        assert.equal(failed.code, 1);
        assert.equal(failed.calls, 0);
        assert.match(failed.response.errors.join('\n'), /conflicts with input/);
        assert.deepEqual(tree(root), before);
    }
});
test('mixed binary/text transaction rolls back after a companion install fails', async t => {
    const root = fixture(t);
    await command(root);
    write(root, 'inputs/r.ttf', Buffer.from([255, 0, 254, 4]));
    write(root, 'books/book.tex', 'old tex');
    const before = tree(root);
    const failed = await command(root, directory => {
        const io = createTransactionIO(directory);
        return { ...io, async rename(from, to) {
            if (from.endsWith('.stage') && to.endsWith('.ttf')) { throw new Error('injected font install failure'); }
            return io.rename(from, to);
        } };
    });
    assert.equal(failed.code, 1);
    assert.match(failed.response.errors.join('\n'), /injected font install failure/);
    assert.deepEqual(tree(root), before);
});
test('planner reads no unselected family bytes and is stable across key ordering', async () => {
    const data = manifest();
    data.families.Unselected.regular = 'private.ttf';
    const reads: string[] = [];
    const io = { async requireFile() {}, async read(name: string) {
        reads.push(name);
        return name === 'manifest.json' ? Buffer.from(JSON.stringify(data)) : bytes;
    } };
    const first = await planFonts('manifest.json', 'books/unsafe % name.tex', ['Example', 'Example'], io);
    assert.ok(!reads.includes('private.ttf'));
    assert.ok(first.inputs.includes('private.ttf'));
    data.families = { Unselected: data.families.Unselected, Example: data.families.Example };
    assert.deepEqual(await planFonts('manifest.json', 'books/unsafe % name.tex', ['Example'], io), first);
});
test('companion output symlinks fail preflight without invoking conversion', async t => {
    const root = fixture(t), first = await command(root);
    const target = path.join(root, first.response.outputs.find(file => file.path.endsWith('.otf'))!.path);
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(root, 'inputs/b.otf'), target);
    const before = tree(root), failed = await command(root);
    assert.equal(failed.code, 1);
    assert.equal(failed.calls, 0);
    assert.match(failed.response.errors.join('\n'), /Symbolic link/);
    assert.deepEqual(tree(root), before);
});
test('portable planner requires defaults, deduplicates inherited roles and excludes extra families', async () => {
    const families = Object.fromEntries(['Latin Modern Roman', 'Monofur Nerd Font',
        'Lilex Nerd Font', 'Unused'].map(name => [name, entry()]));
    const { resolvePublicationSettings } = await import('../../publication-settings');
    const selected = Object.values(resolvePublicationSettings(parseProject([{ path: 'index.literate', text: '# Book' }])).fonts);
    const plan = await planFonts('fonts.json', 'book.tex', selected, {
        async requireFile() {}, async read(name) {
            return name === 'fonts.json' ? Buffer.from(JSON.stringify({ version: 1, families })) : bytes;
        }
    });
    assert.deepEqual(Object.keys(plan.fonts), ['Latin Modern Roman', 'Lilex Nerd Font', 'Monofur Nerd Font']);
    assert.equal(plan.files.length, 15);
    assert.equal(new Set(plan.files.map(file => file.path)).size, 15);
});
test('source path metacharacters remain data and normalized aliases remain protected', async t => {
    const root = fixture(t), data = manifest();
    data.families.Example.regular = 'inputs/font {name}% #.ttf';
    write(root, data.families.Example.regular, bytes);
    write(root, 'config/fonts.json', JSON.stringify(data));
    const result = await command(root);
    assert.equal(result.code, 0, result.response.errors.join('\n'));
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8'), /font \{name\}|inputs\//);
    data.families.Unselected.licenses = ['books/../books/book.tex'];
    write(root, 'config/fonts.json', JSON.stringify(data));
    const before = tree(root), failed = await command(root);
    assert.equal(failed.code, 1);
    assert.equal(failed.calls, 0);
    assert.match(failed.response.errors.join('\n'), /conflicts with input/);
    assert.deepEqual(tree(root), before);
});
test('converter failure publishes no font companions', async t => {
    const root = fixture(t), before = tree(root);
    const code = await run(['latex', root, '--output', 'books/book.tex', '--font-manifest', 'config/fonts.json'],
        { stdout() {}, stderr() {} }, () => { throw new Error('Transaction must not run'); },
        async () => { throw new Error('Conversion failed'); });
    assert.equal(code, 1);
    assert.deepEqual(tree(root), before);
});
test('renderer rejects manually injected unsafe companion paths without emitting tex', async () => {
    const result = await renderLatex(parseProject([{ path: 'index.literate', text: source }]), {
        portableFonts: { Example: { regular: 'evil}\\input{x}.ttf', bold: 'x', italic: 'x', boldItalic: 'x' } }
    }, async () => 'body');
    assert.equal(result.latex, undefined);
    assert.match(result.diagnostics.map(value => value.message).join('\n'), /Invalid or missing portable font/);
});
function faceManifest(value: unknown, face = 'italic'): string {
    return JSON.stringify({ version: 1, families: { Example: { ...entry(), [face]: value } } });
}
const companion = `lit-fonts-${'a'.repeat(64)}/${'b'.repeat(64)}.ttf`;
const portableEntry = (): PortableFont => ({
    regular: companion, bold: companion, italic: companion, boldItalic: companion
});
test('explicit italic and boldItalic synthesis exports safe per-face features', async t => {
    const root = fixture(t);
    write(root, 'config/fonts.json', JSON.stringify({ version: 1, families: { Example: {
        ...entry(), italic: { file: 'inputs/r.ttf', slant: 0.2 },
        boldItalic: { file: 'inputs/b.otf', slant: 0.15 }
    } } }));
    const result = await command(root);
    assert.equal(result.code, 0, result.response.errors.join('\n'));
    const tex = fs.readFileSync(path.join(root, 'books/book.tex'), 'utf8');
    assert.match(tex, /ItalicFeatures=\{FakeSlant=0\.2\}/);
    assert.match(tex, /BoldItalicFeatures=\{FakeSlant=0\.15\}/);
    assert.doesNotMatch(tex, /FakeBold|inputs\//);
    const directory = /Path=\{([^}]+)\}/.exec(tex)![1];
    for (const [option, file] of [['ItalicFont', 'inputs/r.ttf'], ['BoldItalicFont', 'inputs/b.otf']]) {
        const name = new RegExp(`${option}=\\{([^}]+)\\}`).exec(tex)![1];
        assert.deepEqual(fs.readFileSync(path.join(root, 'books', directory, name)), fs.readFileSync(path.join(root, file)));
    }
});
const invalidSynthesis: [string, string, unknown, RegExp][] = [
    ...[0, -0.2, 0.009, 0.301, '0.2', null, true, '0.2},RawFeature={evil}'].map(slant =>
        [`slant ${String(slant)}`, 'italic', { file: 'inputs/r.ttf', slant }, /italic.slant.*0.01 through 0.3/] as [string, string, unknown, RegExp]),
    ['missing slant', 'italic', { file: 'inputs/r.ttf' }, /italic.slant/],
    ['missing file', 'italic', { slant: 0.2 }, /italic.file.*root-relative/],
    ['unsafe file', 'italic', { file: '../escape.ttf', slant: 0.2 }, /italic.file.*root-relative/],
    ['missing input', 'italic', { file: 'missing.ttf', slant: 0.2 }, /Missing file/],
    ['wrong container', 'italic', { file: 'font.woff', slant: 0.2 }, /ttf or .otf/],
    ['extra feature', 'boldItalic', { file: 'inputs/b.otf', slant: 0.2, fakeBold: 1.5 }, /unknown field fakeBold/],
    ['regular object', 'regular', { file: 'inputs/r.ttf', slant: 0.2 }, /only supported for italic and boldItalic/],
    ['bold object', 'bold', { file: 'inputs/b.otf', slant: 0.2 }, /only supported for italic and boldItalic/],
    ['array', 'italic', [], /JSON object/]
];
for (const [name, face, value, error] of invalidSynthesis) {
    test(`explicit synthesis rejects ${name} before conversion`, async t => {
        const root = fixture(t);
        write(root, 'config/fonts.json', faceManifest(value, face));
        write(root, 'books/book.tex', 'previous book');
        const before = tree(root), failed = await command(root);
        assert.equal(failed.code, 1);
        assert.equal(failed.calls, 0);
        assert.match(failed.response.errors.join('\n'), error);
        assert.deepEqual(tree(root), before);
    });
}
test('synthesized face paths reject links and companion collisions', async t => {
    const root = fixture(t), first = await command(root);
    const target = first.response.outputs.find(file => file.path.endsWith('.ttf'))!.path;
    write(root, 'config/fonts.json', faceManifest({ file: target, slant: 0.2 }));
    const collision = await command(root);
    assert.equal(collision.calls, 0);
    assert.match(collision.response.errors.join('\n'), /conflicts with input/);
    fs.symlinkSync(path.join(root, 'inputs/r.ttf'), path.join(root, 'inputs/link.ttf'));
    write(root, 'config/fonts.json', faceManifest({ file: 'inputs/link.ttf', slant: 0.2 }));
    const before = tree(root), linked = await command(root);
    assert.equal(linked.calls, 0);
    assert.match(linked.response.errors.join('\n'), /Symbolic link/);
    assert.deepEqual(tree(root), before);
});
test('synthesis bounds and selective features survive planning', async () => {
    for (const slant of [0.01, 0.2, 0.3]) {
        const plan = await planFonts('fonts.json', 'book.tex', ['Example'], {
            async requireFile() {}, async read(name) {
                return name === 'fonts.json' ? Buffer.from(faceManifest({ file: 'inputs/r.ttf', slant })) : bytes;
            }
        });
        assert.deepEqual(plan.fonts.Example.italic, { file: plan.files[2].path, slant });
        assert.equal(typeof plan.fonts.Example.boldItalic, 'string');
        assert.ok(plan.inputs.includes('inputs/r.ttf'));
        const result = await renderLatex(parseProject([{ path: 'index.literate', text: source }]),
            { portableFonts: plan.fonts }, async () => 'body');
        assert.match(result.latex!, new RegExp(`ItalicFeatures=\\{FakeSlant=${slant}\\}`));
        assert.doesNotMatch(result.latex!, /BoldItalicFeatures|FakeBold/);
    }
    for (const slant of [NaN, Infinity, -Infinity]) {
        assert.throws(() => checkFontFace({ file: companion, slant }, 'italic', 'face', String), /finite number/);
    }
});
test('renderer revalidates explicit synthesis from programmatic callers', async () => {
    const invalid: [string, unknown][] = [
        ...[NaN, Infinity, -Infinity, 0, 0.31, '0.2'].map(slant => ['italic', { file: companion, slant }] as [string, unknown]),
        ['italic', { file: companion, slant: 0.2, features: 'evil' }],
        ['italic', { file: 'evil}\\input{x}.ttf', slant: 0.2 }],
        ['regular', { file: companion, slant: 0.2 }]
    ];
    for (const [face, choice] of invalid) {
        const font = { ...portableEntry(), [face]: choice } as PortableFont;
        const result = await renderLatex(parseProject([{ path: 'index.literate', text: source }]),
            { portableFonts: { Example: font } }, async () => 'body');
        assert.equal(result.latex, undefined);
        assert.ok(result.diagnostics.length, `${face}: ${String(choice)}`);
    }
});
test('Lilex and normal family overrides use native italic lookup', async () => {
    for (const codeFont of ['Lilex Nerd Font', 'Fira Code', 'Other Font', 'D2CodingLigature Nerd Font Propo Extra']) {
        for (const codeLigatures of [true, false]) {
            const result = await renderLatex(parseProject([{ path: 'index.literate', text: source }]),
                { codeFont, codeLigatures }, async () => 'body');
            assert.deepEqual(result.diagnostics, []);
            assert.ok(result.latex!.includes(`]{${codeFont}}`));
            assert.doesNotMatch(result.latex!, /FakeSlant|FakeBold|ItalicFont=/);
            assert.equal(result.latex!.includes('RawFeature={-calt}'), !codeLigatures);
        }
    }
});
test('legacy D2 synthesis is family-specific and never overrides manifest faces', async () => {
    const codeFont = 'D2CodingLigature Nerd Font Propo';
    const project = parseProject([{ path: 'index.literate', text: source }]);
    const familyMode = await renderLatex(project, { codeFont }, async () => 'body');
    assert.deepEqual(familyMode.diagnostics, []);
    assert.match(familyMode.latex!, /ItalicFeatures=\{FakeSlant=0\.2\}/);
    assert.match(familyMode.latex!, /BoldItalicFeatures=\{FakeSlant=0\.2,FakeBold=1\.5\}/);
    const portableMode = await renderLatex(project, {
        codeFont, portableFonts: { Example: portableEntry(), [codeFont]: portableEntry() }
    }, async () => 'body');
    assert.deepEqual(portableMode.diagnostics, []);
    assert.doesNotMatch(portableMode.latex!, /FakeSlant|FakeBold/);
});
