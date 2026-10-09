import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProject } from '../../engine';
import { renderLatex, publicationTemplateVersion } from '../../publication-latex';
import { PandocDocument } from '../../publication-pandoc';

const parse = (text: string) => parseProject([{ path: 'book.literate', text }]);
const path = 'out/publication-probe/highlighting/' + 'long-directory/'.repeat(16) + 'ENDPATH.cjs';
const inlineSpace = String.raw`\hspace{\fontdimen2\font}\allowbreak{}`;

async function capture(text: string): Promise<{ document: PandocDocument; latex: string }> {
    let document!: PandocDocument;
    const result = await renderLatex(parse(text), {}, async value => {
        document = value;
        return 'Body';
    });
    assert.deepEqual(result.diagnostics, []);
    return { document, latex: result.latex! };
}

function codes(document: PandocDocument): string[] {
    const result: string[] = [];
    JSON.stringify(document, (_key, value) => {
        if (value?.t === 'RawInline' && value.c[1].startsWith('\\LitInlineCode{')) {
            result.push(value.c[1]);
        }

        return value;
    });
    return result;
}

test('inline code wraps in formatting, links and containers while retaining heading code and source', async () => {
    const text = '# `HeadingCode`\n\n**`BoldCode`** *`ItalicCode`* ~~`StrikeCode`~~\n\n' +
        '[`LinkCode`](#headingcode)\n\n> - `QuoteCode`\n\n1. `ListCode`\n\n`' + path + '`';
    const project = parse(text);
    const before = JSON.stringify(project);
    const result = await renderLatex(project, {}, async document => {
        assert.equal(codes(document).length, 7);
        const encoded = JSON.stringify(document);
        assert.equal((encoded.match(/"t":"Code"/g) || []).length, 1);
        assert.ok(encoded.includes('"HeadingCode"'));
        for (const kind of ['Header', 'Strong', 'Emph', 'Strikeout', 'Link', 'BlockQuote', 'BulletList', 'OrderedList']) {
            assert.ok(encoded.includes('"t":"' + kind + '"'), kind);
        }
        assert.ok(codes(document).includes('\\LitInlineCode{' + Array.from(path).join('\\allowbreak{}') + '}'));
        return 'Body';
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(project), before);
});

test('inline code escapes TeX data, keeps spaces breakable and does not split Unicode sequences', async () => {
    const text = '\\input{NOT-A-FILE} # $ % & _ ^ ~ { } café e\u0301 👩‍💻';
    const { document } = await capture('`' + text + '`');
    const [code] = codes(document);
    const visible = code.split(inlineSpace).join(' ').replace(/\\allowbreak\{\}/g, '');
    assert.equal(visible, String.raw`\LitInlineCode{\textbackslash{}input\{NOT-A-FILE\} \# \$ \% \& \_ \textasciicircum{} \textasciitilde{} \{ \} café é 👩‍💻}`);
    assert.ok(code.includes('é' + inlineSpace + '👩‍💻'));
    assert.doesNotMatch(code, /\\input\{|\\directlua|\\ /);
});

test('inline spaces remain explicit and breakable after Markdown whitespace normalization', async () => {
    const samples = [
        ['`a b`', 'a b'], ['`a  b`', 'a  b'], ['`a    b`', 'a    b'],
        ['`  a  b  `', ' a  b '], ['`   `', ' '], ['`a\nb`', 'a b']
    ];
    const { document } = await capture(samples.map(([markdown]) => markdown).join('\n\n'));
    assert.deepEqual(codes(document), samples.map(([, normalized]) =>
        '\\LitInlineCode{' + normalized.split(' ').join(inlineSpace) + '}'));
});

test('template identifies its contract and keeps fenced/reference wrapping and default fonts', async () => {
    const { document, latex } = await capture('`InlineCode`\n\n```js\nconst fenced = "' + path + '";\n```\n\n' +
        '```js : <<Caller>>=\n<<Shared>>\n```\n\n```js : <<Shared>>=\nconst shared = 1;\n```');
    assert.equal(publicationTemplateVersion, 5);
    assert.ok(latex.startsWith('% Literate publication template v5\n'));
    assert.ok(latex.includes('\\documentclass[fontsize=11pt,oneside,openany]{scrbook}'));
    assert.ok(latex.includes('\\newcommand{\\LitCodeSize}{\\fontsize{10pt}{12pt}\\selectfont}'));
    assert.ok(latex.includes('\\DeclareRobustCommand{\\LitInlineCode}[1]{\\texttt{#1}}'));

    assert.ok(latex.includes('\\setlength{\\emergencystretch}{3em}'));
    for (const part of ['Lilex Nerd Font', 'Monofur Nerd Font', 'breakanywhere=true',
        '\\FancyVerbBreakStart#4\\FancyVerbBreakStop', '\\newcommand{\\LitReferenceA}']) {
        assert.ok(latex.includes(part), part);
    }
    assert.equal(codes(document).length, 1);
    assert.ok(JSON.stringify(document).includes(path));
    assert.doesNotMatch(latex, /\\renewcommand\{\\texttt\}|\\sloppy|\\resizebox/);
});

test('inline NOTE bodies and TERM labels retain M6 rail handling', async () => {
    const text = '# Rail\n\n```TERM alpha "Alpha"\nDefinition with `TermCode`.\n```\n\n' +
        '```NOTE\nNote with `NoteCode`.\n```\n\n[`LabelCode`](term:alpha)';
    const seen: string[] = [];
    const result = await renderLatex(parse(text), {}, async document => {
        seen.push(...codes(document));
        return 'Controlled body';
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(seen.length, 4);
    assert.match(result.latex!, /% literate-publication-rail-v1/);
    assert.match(result.latex!, /\\microtypesetup\{protrusion=false\}/);
});

const evidence = process.env.LITERATE_POLISH_EVIDENCE;
test('opt-in real Pandoc fixtures for LuaLaTeX acceptance', { skip: !evidence }, async () => {
    mkdirSync(evidence!, { recursive: true });
    const text = '# Inline `HeadingCode`\n\nA prose path `' + path + '` followed by ordinary prose.\n\n' +
        '**`BoldCode`** *`ItalicCode`* ***`BothCode`*** ~~`StrikeCode`~~\n\n' +
        '`SpaceOneA SpaceOneB`\n\n`SpaceTwoA  SpaceTwoB`\n\n`SpaceFourA    SpaceFourB`\n\n' +
        '`verifySelfHosting(root, documents, templates, files)`\n\n' +
        '`\\input{NOT-A-FILE} # $ % & _ ^ ~ { } café é`\n\n' +
        '> - Nested `' + path + '`\n\n' +
        '```js\nconst fenced = "' + path + '";\n```\n\n' +
        '```js : <<Caller>>=\n<<Shared>>\n```\n\n```js : <<Shared>>=\nconst shared = 1;\n```';
    for (const paper of ['A4', 'A5'] as const) {
        for (const theme of ['rosepine-dawn', 'hermonica', 'flexoki-light']) {
            const margins = paper === 'A5' ? { marginLeftMm: 20, marginRightMm: 16 } : {};
            const result = await renderLatex(parse(text), { paper, theme, ...margins }, async document => {
                const process = spawnSync('pandoc', ['-f', 'json', '-t', 'latex', '--no-highlight', '--top-level-division=chapter'],
                    { input: JSON.stringify(document), encoding: 'utf8', timeout: 30000 });
                assert.equal(process.status, 0, process.stderr);
                return process.stdout;
            });
            assert.deepEqual(result.diagnostics, []);
            assert.match(result.latex!, /\{Inline HeadingCode\}/);
            const name = `${paper}-${theme}`;
            writeFileSync(join(evidence!, name + '.tex'), result.latex!);
            writeFileSync(join(evidence!, name + '-baseline.tex'), result.latex!
                .replace(/\\allowbreak\{\}/g, '')
                .replace('\\setlength{\\emergencystretch}{3em}', '\\setlength{\\emergencystretch}{0pt}'));
        }
    }
});
