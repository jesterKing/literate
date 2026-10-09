import assert = require('node:assert/strict');
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseProject } from '../../engine';
import { preparePandoc, PandocBlock, PandocInline } from '../../publication-pandoc';
import { renderLatex, LatexConverter } from '../../publication-latex';
import { createPdfCompiler } from '../../publication-pdf';
import { collectAssets } from '../../publication-assets';

const parse = (text: string) => parseProject([{ path: 'book.literate', text }]);
const term = '```TERM alpha "Alpha & beta"\nDefinition *emphasis* and `code`.\n```\n';
const note = '```NOTE\nA **bold** note with [definition](term:alpha).\n\n- first\n- second\n```\n';
const encode = (value: string) => 'lit-' + value.split('').map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
function inlines(values: PandocInline[]): string {
    return values.map(value => {
        switch (value.t) {
            case 'RawInline': return value.c[1];
            case 'Str': return value.c;
            case 'Space': case 'SoftBreak': case 'LineBreak': return ' ';
            case 'Code': return `\\texttt{${value.c[1]}}`;
            case 'Emph': return `\\emph{${inlines(value.c)}}`;
            case 'Strong': return `\\textbf{${inlines(value.c)}}`;
            case 'Strikeout': return inlines(value.c);
            case 'Link': return inlines(value.c[1]);
        }
    }).join('');
}
function blocks(values: PandocBlock[]): string {
    return values.map(value => {
        switch (value.t) {
            case 'RawBlock': return value.c[1];
            case 'Para': case 'Plain': return inlines(value.c) + '\n';
            case 'Header': return inlines(value.c[2]);
            case 'Div': return blocks(value.c[1]);
            case 'BlockQuote': return blocks(value.c);
            case 'BulletList': return value.c.map(blocks).join('\n');
            case 'OrderedList': return value.c[1].map(blocks).join('\n');
            default: return '';
        }
    }).join('\n');
}
const convert: LatexConverter = async document => blocks(document.blocks);

test('annotations preserve bodies, use labels once, share encoded targets and avoid rail recursion', async () => {
    const project = parse('# Book\n\n[**Unique label**](term:alpha).\n\n' + term + note);
    const before = JSON.stringify(project);
    const calls: string[] = [];
    const result = await renderLatex(project, {}, async (document, options) => {
        assert.equal(options.syntaxHighlighting, 'none');
        const text = blocks(document.blocks);
        calls.push(text);
        return calls.length === 1 ? 'NOTE-SENTINEL ' + text : text;
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(project), before);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /\\textbf\{bold\}/);
    assert.match(calls[0], /first[\s\S]*second/);
    assert.doesNotMatch(calls[0], /\\LitTermUse|\\LitNoteUse/);
    assert.match(calls[0], /\\hyperref\[lit-[a-f0-9]+\]/);
    assert.match(calls[0], /\\pageref\*/);
    const latex = result.latex!;
    const destination = encode(project.annotations.terms[0].target);
    assert.ok(latex.includes(`\\label{${destination}}`));
    assert.ok(latex.includes(`\\LitTermUse{lit-use-1}{${destination}}{\\hyperref[${destination}]{\\textbf{Unique label}`));
    assert.equal(latex.split('Unique label').length - 1, 1);
    assert.ok(latex.includes('Definition \\emph{emphasis} and \\LitInlineCode{c\\allowbreak{}o\\allowbreak{}d\\allowbreak{}e}'));
    assert.match(latex, /NOTE-SENTINEL/);
    assert.match(latex, /\\textbf\{Alpha \\& beta\}/);
    assert.match(latex, /right=50mm/);
    assert.match(latex, /\\marginparwidth\}\{25mm\}/);
    assert.match(latex, /\\marginparsep\}\{5mm\}/);
    assert.match(latex, /\\microtypesetup\{protrusion=false\}/);
    assert.ok(latex.indexOf('\\newfontfamily\\notefont') < latex.indexOf('% literate-publication-rail-v1'));
    assert.ok(latex.indexOf('{hyperref}') < latex.indexOf('% literate-publication-rail-v1'));
    assert.doesNotMatch(latex.slice(latex.indexOf('\\chapter*{Term index}')), /\\LitTermUse|\\LitNoteUse/);
});

test('mirrored annotation rail uses the outer edge and configured rail size', async () => {
    const project = parseProject([{ path: 'index.literate', text:
        '```SETTINGS\nfont-size-rail=10\n```\n# Book\n\n```NOTE\nMirrored note.\n```\n' }]);
    const result = await renderLatex(project, { marginInnerMm: 14, marginOuterMm: 20 }, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex!.includes('\\documentclass[fontsize=11pt,twoside,openany]{scrbook}'));
    assert.ok(result.latex!.includes('outer=50mm'));
    assert.ok(result.latex!.includes('inner=14mm'));
    assert.ok(result.latex!.includes('\\fontsize{10pt}{12pt}\\selectfont'));
    assert.ok(result.latex!.includes('\\ReadonlyShipoutCounter'));
});

for (const invalid of [
    '```TERM bad unquoted\nbody\n```',
    term + term,
    '[missing](term:absent)',
    '```NOTE\n![image](x.png)\n```',
    '```NOTE\n<div>raw</div>\n```',
    '```NOTE\n    code\n```',
    '```NOTE\n[bad](ftp://example.com/secret)\n```',
    term + '# [heading](term:alpha)\n'
]) {
    test('annotation validation gates all callbacks: ' + invalid.slice(0, 45), async () => {
        const project = parse('```js : <<part>>=\ncode\n```\n\n' + invalid);
        let calls = 0;
        const prepared = preparePandoc(project, () => { calls++; return []; }, () => { calls++; return []; });
        assert.equal(prepared.document, undefined);
        assert.ok(prepared.diagnostics.length);
        const result = await renderLatex(project, {}, async () => { calls++; return ''; });
        assert.equal(result.latex, undefined);
        assert.ok(result.diagnostics.length);
        assert.equal(calls, 0);
    });
}

test('annotation body document links validate before callbacks and assets preflight sees semantic blocks', () => {
    const valid = preparePandoc(parse(term + note), () => assert.fail('not code'), () => assert.fail('not assets'));
    assert.deepEqual(valid.diagnostics, []);
    assert.doesNotMatch(JSON.stringify(valid.document), /CodeBlock/);
    assert.deepEqual(collectAssets(parse(term + note)), { assets: [], diagnostics: [] });
    const bad = preparePandoc(parse('```NOTE\n[missing](absent.literate)\n```'), () => assert.fail());
    assert.ok(bad.diagnostics.some(item => item.code === 'missing-publication-document'));
});

test('A5 rail geometry is conditional and validates original margins and remaining body', async () => {
    assert.deepEqual((await renderLatex(parse('ordinary'), { paper: 'A5' }, convert)).diagnostics, []);
    const rejected = await renderLatex(parse(term), { paper: 'A5' }, async () => assert.fail());
    assert.equal(rejected.diagnostics[0].code, 'latex-options');
    const accepted = await renderLatex(parse(term), { paper: 'A5', marginTopMm: 18,
        marginRightMm: 16, marginBottomMm: 22, marginLeftMm: 20 }, convert);
    assert.deepEqual(accepted.diagnostics, []);
    assert.match(accepted.latex!, /top=18mm,right=46mm,bottom=22mm,left=20mm/);
    for (const options of [{ marginRightMm: 51 }, { paper: 'A5' as const, marginMm: 50 }]) {
        const result = await renderLatex(parse(term), options, convert);
        assert.equal(result.latex, undefined);
    }
});

test('plain books retain layout and indexes are conditional; annotated fragment index links contributions', async () => {
    const code = '```js : <<piece>>=\nbase\n```\n\n```js : <<piece>>=+\nextra\n```\n';
    const plain = await renderLatex(parse(code), {}, convert);
    assert.deepEqual(plain.diagnostics, []);
    assert.match(plain.latex!, /margin=20mm/);
    assert.doesNotMatch(plain.latex!, /Term index|Fragment index|literate-publication-rail-v1/);
    const project = parse(term + code);
    const annotated = await renderLatex(project, {}, convert);
    assert.deepEqual(annotated.diagnostics, []);
    const index = annotated.latex!.split('\\chapter*{Fragment index}')[1];
    for (const part of project.publication.contributions) {
        assert.ok(index.includes(`\\pageref*{${encode(part.target)}}`));
    }
});

test('nested prose uses get unique source-order markers and body uses never get markers', async () => {
    const project = parse(term + '\n- [one](term:alpha)\n\n  > [two](term:alpha)\n\n- [three](term:alpha)\n');
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual([...result.latex!.matchAll(/\\LitTermUse\{(lit-use-\d+)\}/g)].map(match => match[1]),
        ['lit-use-1', 'lit-use-2', 'lit-use-3']);
});

for (const certificate of [undefined, 'pending hash\n', 'error\noverflow\n', 'stable nonsense\n', 'stable ' + 'a'.repeat(32) + '\n']) {
    test('PDF rail certificate gate: ' + certificate, async () => {
        const compiler = createPdfCompiler(async request => {
            if (request.args.includes('--version')) { return { code: 0, output: 'installed' }; }
            if (request.command === 'kpsewhich') { return { code: 0, output: '/tex/package' }; }
            await fs.writeFile(path.join(request.cwd, 'book.log'), '');
            await fs.writeFile(path.join(request.cwd, 'book.pdf'), '%PDF-1.7\nfixture');
            if (certificate !== undefined) { await fs.writeFile(path.join(request.cwd, 'book.litrail'), certificate); }
            return { code: 0, output: '' };
        });
        const action = compiler([{ path: 'book.tex', content: '% literate-publication-rail-v1\n' }], 'book.tex');
        if (certificate?.startsWith('stable a')) { assert.ok((await action).pdf.length); }
        else { await assert.rejects(action, /rail/i); }
    });
}

test('body links stay marker-free, and a failed asynchronous body converter returns no partial book', async () => {
    const project = parse(term + '```TERM other "Other"\n[**inside**](term:alpha)\n```\n' + note);
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.doesNotMatch(result.latex!, /\\LitTermUse\{lit-use-/);
    assert.match(result.latex!, /\\hyperref\[lit-[a-f0-9]+\]\{\\textbf\{inside\}/);
    const failed = await renderLatex(project, {}, async () => { throw new Error('body conversion failed'); });
    assert.equal(failed.latex, undefined);
    assert.equal(failed.diagnostics[0].code, 'latex-conversion');
});

for (const certificate of [undefined, 'pending hash\n']) {
    test('ordinary PDF ignores body marker text but rejects any present unstable certificate: ' + certificate, async () => {
        const compiler = createPdfCompiler(async request => {
            if (request.args.includes('--version')) { return { code: 0, output: 'installed' }; }
            if (request.command === 'kpsewhich') { return { code: 0, output: '/tex/package' }; }
            await fs.writeFile(path.join(request.cwd, 'book.log'), '');
            await fs.writeFile(path.join(request.cwd, 'book.pdf'), '%PDF-1.7\nfixture');
            if (certificate !== undefined) { await fs.writeFile(path.join(request.cwd, 'book.litrail'), certificate); }
            return { code: 0, output: '' };
        });
        const action = compiler([{ path: 'book.tex', content: '\\begin{document}\n% literate-publication-rail-v1\n' }], 'book.tex');
        if (certificate === undefined) { assert.ok((await action).pdf.length); }
        else { await assert.rejects(action, /rail/i); }
    });
}

for (const body of ['', '\n \t\n']) {
    test('empty NOTE skips body conversion but retains its numbered rail entry: ' + JSON.stringify(body), async () => {
        let calls = 0;
        const project = parse('```NOTE\n' + body + '```\n');
        const result = await renderLatex(project, {}, async document => {
            calls++;
            assert.ok(document.blocks.length, 'empty body must not reach the converter');
            const output = blocks(document.blocks);
            assert.match(output, /\\LitNoteUse\{/);
            return output;
        });
        assert.deepEqual(result.diagnostics, []);
        assert.equal(calls, 1, 'only the complete book is converted');
        assert.match(result.latex!, /\\textbf\{1\.\}\\space /);
    });
}

test('1000 empty notes are accepted without body conversions', async () => {
    const project = parse('```NOTE\n```\n'.repeat(1000));
    let calls = 0;
    const result = await renderLatex(project, {}, async document => { calls++; return blocks(document.blocks); });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(calls, 1);
    assert.match(result.latex!, /\\textbf\{1000\.\}\\space /);
});

for (const kind of ['TERM', 'NOTE']) {
    test(kind + ' declaration limit rejects 1001 entries before any converter', async () => {
        const source = Array.from({ length: 1001 }, (_, i) =>
            '```' + (kind === 'TERM' ? `TERM key${i} "Title"` : 'NOTE') + '\nbody\n```\n').join('');
        const project = parse(source);
        assert.deepEqual(project.diagnostics, []);
        let calls = 0;
        const result = await renderLatex(project, {}, async () => { calls++; return ''; });
        assert.equal(calls, 0);
        assert.equal(result.latex, undefined);
        assert.match(result.diagnostics[0].message, /at most 1000 terms and 1000 notes/);
    });
}

for (const kind of ['TERM key "Title"', 'NOTE']) {
    test(kind + ' oversized source body rejects before converting an earlier valid note', async () => {
        const project = parse('```NOTE\nsmall\n```\n```' + kind + '\n' + 'x'.repeat(131072) + '\n```\n');
        let calls = 0;
        const result = await renderLatex(project, {}, async () => { calls++; return ''; });
        assert.equal(calls, 0);
        assert.equal(result.latex, undefined);
        assert.match(result.diagnostics[0].message, /source body exceeds 131072/);
    });
}

test('cumulative source bodies are bounded before any converter', async () => {
    const project = parse(('```NOTE\n' + 'x'.repeat(125000) + '\n```\n').repeat(17));
    let calls = 0;
    const result = await renderLatex(project, {}, async () => { calls++; return ''; });
    assert.equal(calls, 0);
    assert.equal(result.latex, undefined);
    assert.match(result.diagnostics[0].message, /content exceeds 2 MiB/);
});

test('encoded declaration metadata participates in upfront limits', async () => {
    const source = Array.from({ length: 1000 }, (_, i) =>
        '```TERM key' + i + 'x'.repeat(90) + ' "Title"\n```\n').join('');
    let calls = 0;
    const result = await renderLatex(parse(source), {}, async () => { calls++; return ''; });
    assert.equal(calls, 0);
    assert.equal(result.latex, undefined);
    assert.match(result.diagnostics[0].message, /content exceeds 2 MiB/);
});

for (const output of ['x'.repeat(131073), 'invalid\u0000output']) {
    test('invalid converted note stops immediately: ' + output.length, async () => {
        const project = parse('```NOTE\nfirst\n```\n```NOTE\nsecond\n```\n');
        let calls = 0;
        const result = await renderLatex(project, {}, async () => { calls++; return output; });
        assert.equal(calls, 1, 'neither the next note nor the book may be converted');
        assert.equal(result.latex, undefined);
        assert.equal(result.diagnostics[0].code, 'latex-conversion');
        assert.match(result.diagnostics[0].message, /Invalid or oversized controlled rail/);
    });
}

test('converted bodies stop at the cumulative output budget, including encoded metadata', async () => {
    const project = parse('```NOTE\nsmall\n```\n'.repeat(17));
    let calls = 0;
    const result = await renderLatex(project, {}, async () => { calls++; return 'x'.repeat(131072); });
    assert.equal(calls, 16, 'metadata plus sixteen maximum bodies exceeds 2 MiB; no seventeenth call');
    assert.equal(result.latex, undefined);
    assert.match(result.diagnostics[0].message, /content exceeds 2 MiB/);
});

test('maximum source and converted body sizes are inclusive', async () => {
    const project = parse('```NOTE\n' + 'x'.repeat(131071) + '\n```\n');
    let calls = 0;
    const result = await renderLatex(project, {}, async document => {
        calls++;
        return calls === 1 ? 'x'.repeat(131072) : blocks(document.blocks);
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(calls, 2);
});

test('real Pandoc preserves controlled note lists, emphasis, inline code and linked labels', {
    skip: process.env.LITERATE_TEST_PANDOC !== '1'
}, async () => {
    const result = await renderLatex(parse(term + note + '\n[**Label**](term:alpha)'), {}, async document => {
        const converted = spawnSync('pandoc', ['-f', 'json', '-t', 'latex', '--no-highlight', '--top-level-division=chapter'],
            { input: JSON.stringify(document), encoding: 'utf8' });
        assert.equal(converted.status, 0, converted.stderr);
        return converted.stdout;
    });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.latex!, /\\begin\{itemize\}/);
    assert.match(result.latex!, /\\emph\{emphasis\}/);
    assert.ok(result.latex!.includes('\\LitInlineCode{c\\allowbreak{}o\\allowbreak{}d\\allowbreak{}e}'));
    assert.match(result.latex!, /\\LitTermUse\{lit-use-1\}\{lit-[a-f0-9]+\}\{\\hyperref\[lit-[a-f0-9]+\]\{\\textbf\{Label\}/);
});
