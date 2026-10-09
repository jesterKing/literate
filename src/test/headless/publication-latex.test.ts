import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseProject } from '../../engine';
import { renderLatex, LatexOptions, LatexConverter } from '../../publication-latex';
import { PandocBlock } from '../../publication-pandoc';
import { themes } from '../../themes';

function fence(name: string, body: string, append = ''): string {
    return `\`\`\`js: <<${name}>>=${append}\n${body}\n\`\`\`\n`;
}
const parse = (text: string) => parseProject([{ path: 'book.literate', text }]);
function raw(blocks: PandocBlock[]): string {
    return blocks.map(block => {
        if (block.t === 'RawBlock') { return block.c[1]; }
        if (block.t === 'Div') { return raw(block.c[1]); }
        if (block.t === 'BlockQuote') { return raw(block.c); }
        if (block.t === 'BulletList') { return block.c.map(raw).join('\n'); }
        if (block.t === 'OrderedList') { return block.c[1].map(raw).join('\n'); }
        return '';
    }).join('\n');
}
const convert: LatexConverter = async (document, options) => {
    assert.deepEqual(options, { standalone: false, syntaxHighlighting: 'none', topLevelDivision: 'chapter' });
    return raw(document.blocks);
};

for (const theme of themes) {
    test(`LaTeX accepts catalogue theme ${theme.name} without print remapping`, async () => {
        const result = await renderLatex(parse(fence('part', 'const n = 1; // comment')), { theme: theme.name }, convert);
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.latex);
        assert.ok(result.latex.includes(`{publicationBackground}{HTML}{${theme.colors.background.slice(1)}}`));
        assert.ok(result.latex.includes('\\pagecolor{publicationBackground}'));
        assert.ok(result.latex.includes('Copyright © 2019 Ashkan Kiani'));
        assert.ok(result.latex.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
        assert.match(result.latex, /\\LitStyle\{[A-Fa-f0-9]+\}\{\\bfseries\}/);
        assert.match(result.latex, /\\LitStyle\{[A-Fa-f0-9]+\}\{\}\{\\itshape\}/);
    });
}

test('LaTeX defaults are borderless, ligature-enabled and use native Lilex styles', async () => {
    const result = await renderLatex(parse(''), {}, convert);
    assert.deepEqual(result.diagnostics, []);
    for (const expected of ['a4paper,margin=20mm', 'Latin Modern Roman', 'Monofur Nerd Font',
        'Lilex Nerd Font', 'Ligatures=Common,Contextuals=Alternate',
        'fontsize=11pt', '\\fontsize{10pt}{12pt}\\selectfont',
        'frame=none', '\\FancyVerbBreakStart#4\\FancyVerbBreakStop', 'breakanywheresymbolpre={}']) {
        assert.ok(result.latex?.includes(expected), expected);
    }
    assert.doesNotMatch(result.latex!, /Path=|\/home\/|RawFeature=\{-calt|FakeSlant|FakeBold|ItalicFont=/);
});

test('root settings independently select body and block-code point sizes', async () => {
    const project = parseProject([{ path: 'index.literate', text:
        '```SETTINGS\nfont-size-body=12.5\nfont-size-code=8.25\n```\n# Book\n' }]);
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex!.includes('\\documentclass[fontsize=12.5pt,oneside,openany]{scrbook}'));
    assert.ok(result.latex!.includes('\\fontsize{8.25pt}{9.9pt}\\selectfont'));
});

test('LaTeX links full hanging names, distinct contribution labels and navigation', async () => {
    const name = 'AccumulateWeightedRadiance'.repeat(6);
    const project = parse(fence('caller', `before <<${name}>> after`) + fence(name, 'base') + fence(name, 'addition', '+'));
    const before = JSON.stringify(project);
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(project), before);
    const latex = result.latex!;
    assert.ok(latex.includes(Array.from(name).join('\\allowbreak{}')));
    assert.match(latex, /\\newcommand\{\\LitReferenceA\}\{\\par\\begingroup/);
    assert.match(latex, /\\textsuperscript\{\\notefont\\pageref\*/);
    assert.match(latex, /Previous /); assert.match(latex, /Next /); assert.match(latex, /Base /);
    assert.match(latex, /\\ensuremath\{\+\\equiv\}/);
    const labels = [...latex.matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1]);
    assert.equal(labels.length, 5); assert.equal(new Set(labels).size, 5);
    assert.ok(latex.indexOf('before') < latex.indexOf('\\LitReferenceA{}'));
    assert.ok(latex.indexOf('\\LitReferenceA{}') < latex.indexOf('after'));
    assert.doesNotMatch(latex.slice(latex.indexOf('\\begin{document}')), /\\parbox/);
});

test('standalone references become marker baselines while inline references stay in the code body', async () => {
    const project = parse(fence('caller', '  <<leaf>>  \nbefore <<leaf>> after') + fence('leaf', 'value'));
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    const latex = result.latex!;
    const first = latex.slice(latex.indexOf('\\newcommand{\\LitReferenceA}'),
        latex.indexOf('\\newcommand{\\LitReferenceB}'));
    const second = latex.slice(latex.indexOf('\\newcommand{\\LitReferenceB}'),
        latex.indexOf('% literate-publication-rail-v1'));
    assert.match(first, /\\LitFragmentUse\{lit-[a-f0-9]+\}\{lit-[a-f0-9]+\}\\strut/);
    assert.doesNotMatch(first, /textless|pageref/);
    assert.doesNotMatch(second, /\\LitFragmentUse/);
    assert.match(second, /textless[\s\S]*pageref/);
    assert.match(latex, /literate-publication-rail-v1/);
});

test('LaTeX moves document anchors after opening headings without mutating parsed input', async () => {
    const project = parse('# Chapter\n\nText');
    const before = JSON.stringify(project);
    const result = await renderLatex(project, {}, async document => {
        const block = document.blocks[0];
        assert.equal(block.t, 'Div');
        if (block.t !== 'Div') { throw new Error('Expected document Div'); }
        assert.equal(block.c[0][0], '');
        assert.equal(block.c[1][0].t, 'Header');
        assert.deepEqual(block.c[1][1], { t: 'RawBlock', c: ['latex',
            '\\phantomsection\\label{d-0062006f006f006b002e006c0069007400650072006100740065}'] });
        return raw(document.blocks);
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(project), before);
});

test('LaTeX keeps TeX-looking code as data and escaped openers literal', async () => {
    const project = parse(fence('safe', '\\end{Verbatim} % # $ & _ ^ ~ { }\n\\<<not a reference>>'));
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex?.includes('\\textbackslash{}end'));
    assert.ok(result.latex?.includes('\\textbraceleft{}'));
    assert.ok(result.latex?.includes('<<not a reference>>'));
    assert.doesNotMatch(result.latex!, /\\newcommand\{\\LitReference/);
});

test('LaTeX encodes every fragment-name TeX metacharacter', async () => {
    const result = await renderLatex(parse(fence('a # $ % & _ ^ ~ { } \\ z', '1')), {}, convert);
    assert.deepEqual(result.diagnostics, []);
    for (const escaped of ['\\#', '\\$', '\\%', '\\&', '\\_', '\\textasciicircum{}',
        '\\textasciitilde{}', '\\{', '\\}', '\\textbackslash{}']) {
        assert.ok(result.latex?.includes(escaped), escaped);
    }
});

test('LaTeX merges adjacent equivalent scopes instead of splitting operators into groups', async () => {
    const result = await renderLatex(parse(fence('ops', 'left !== right && left <= right;')), {}, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex?.includes('{left !== right && left <= right;}'));
});

const marginSides = ['marginTopMm', 'marginRightMm', 'marginBottomMm', 'marginLeftMm'] as const;
const allMarginSides = [...marginSides, 'marginInnerMm', 'marginOuterMm'] as const;
const invalidOptions: LatexOptions[] = [
    ...allMarginSides.flatMap(side => [NaN, Infinity, -Infinity, 4.9, 50.1, '20'].map(value =>
        ({ [side]: value } as LatexOptions))),
    { paper: 'A5', marginLeftMm: 50, marginRightMm: 19 },
    { paper: 'A5', marginLeftMm: 19, marginRightMm: 50 },
    { marginLeftMm: 10, marginInnerMm: 10 },
    { marginRightMm: 10, marginOuterMm: 10 },
    { codeLigatures: 'off' as unknown as boolean },
    ...['bodyFont', 'headingFont', 'fragmentFont', 'noteFont'].flatMap(role =>
        ['', '../font', 'bad\\input', 'A'.repeat(101)].map(value => ({ [role]: value }))),
    { theme: 'unknown' }, { paper: 'a4' as LatexOptions['paper'] },
    ...[NaN, Infinity, -1, 0, 4.9, 50.1].map(marginMm => ({ marginMm })),
    { paper: 'A5', marginMm: 35 },
    ...['', 'bad\\input', 'font[Path=x]', 'font{foo}', 'font%comment', 'font\nname', '../font', 'é'].map(codeFont => ({ codeFont }))
];
for (const [index, options] of invalidOptions.entries()) {
    test(`LaTeX rejects unsafe options before conversion ${index}`, async () => {
        let calls = 0;
        const result = await renderLatex(parse(''), options, async () => { calls++; return ''; });
        assert.equal(calls, 0); assert.equal(result.latex, undefined);
        assert.equal(result.diagnostics[0].code, 'latex-options');
        assert.equal(result.diagnostics[0].line, 0); assert.equal(result.diagnostics[0].column, 0);
    });
}
for (const paper of ['A4', 'A5', 'letter', 'legal'] as const) {
    test(`LaTeX accepts guarded paper ${paper}`, async () => {
        const result = await renderLatex(parse(''), { paper, marginMm: 20.5 }, convert);
        assert.deepEqual(result.diagnostics, []); assert.ok(result.latex?.includes('margin=20.5mm'));
    });
}

for (const side of marginSides) {
    test(`LaTeX applies individual ${side} and falls back per side`, async () => {
        for (const marginMm of [undefined, 21]) {
            const result = await renderLatex(parse(''), { marginMm, [side]: 5 }, convert);
            assert.deepEqual(result.diagnostics, []);
            const expected = marginSides.map((key, index) =>
                `${['top', 'right', 'bottom', 'left'][index]}=${key === side ? 5 : marginMm ?? 20}mm`).join(',');
            assert.ok(result.latex?.includes(`[a4paper,${expected}]{geometry}`));
        }
    });
}

test('LaTeX mirrors inner and outer margins across two-sided pages', async () => {
    const result = await renderLatex(parse(''), { marginTopMm: 18, marginOuterMm: 20,
        marginBottomMm: 22, marginInnerMm: 14 }, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex!.includes('\\documentclass[fontsize=11pt,twoside,openany]{scrbook}'));
    assert.ok(result.latex!.includes('[a4paper,top=18mm,outer=20mm,bottom=22mm,inner=14mm]{geometry}'));
});

test('LaTeX reserves the mirrored outer edge for annotation and fragment rails', async () => {
    const result = await renderLatex(parse('```NOTE\nBinding note.\n```\n' +
        fence('caller', '<<leaf>>') + fence('leaf', 'value')),
        { marginInnerMm: 14, marginOuterMm: 20 }, convert);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex!.includes('\\documentclass[fontsize=11pt,twoside,openany]{scrbook}'));
    assert.ok(result.latex!.includes('outer=50mm'));
    assert.ok(result.latex!.includes('inner=14mm'));
    assert.ok(result.latex!.includes('\\ReadonlyShipoutCounter'));
});

test('LaTeX validates opposite-side sums and keeps inclusive margin bounds', async () => {
    const result = await renderLatex(parse(''), { paper: 'A5', marginTopMm: 50,
        marginRightMm: 18, marginBottomMm: 50, marginLeftMm: 50 }, convert);
    assert.deepEqual(result.diagnostics, []); // 80 mm wide, 110 mm high (smallest paper).
    assert.ok(result.latex?.includes('top=50mm,right=18mm,bottom=50mm,left=50mm'));
    const invalid = await renderLatex(parse(''), { marginMm: NaN, marginTopMm: 20,
        marginRightMm: 20, marginBottomMm: 20, marginLeftMm: 20 }, convert);
    assert.equal(invalid.latex, undefined);
});

const rootSettings = (settings: string, text = '') => parseProject([
    { path: 'index.literate', text: '```SETTINGS\n' + settings + '\n```\n' + text }
]);

test('LaTeX root settings select independent font roles and their command sites', async () => {
    const project = rootSettings('font-body=Body\nfont-heading=Heading\nfont-code=Code\n' +
        'font-fragment=Fragment\nfont-note=Note\nfont-code-ligatures=off',
        fence('leaf', 'x') + fence('leaf', 'y', '+') + fence('caller', '<<leaf>>'));
    const before = JSON.stringify(project);
    const result = await renderLatex(project, {}, convert);
    assert.deepEqual(result.diagnostics, []);
    for (const expected of ['\\setmainfont{Body}', '\\newfontfamily\\headingfont{Heading}',
        '\\newfontfamily\\fragmentfont{Fragment}', '\\newfontfamily\\notefont{Note}',
        ']{Code}', '\\setkomafont{disposition}{\\headingfont',
        '\\setkomafont{pageheadfoot}{\\notefont', '\\setkomafont{footnote}{\\notefont}',
        '{\\notefont\\small ', '\\fragmentfont\\small\\noindent',
        '\\fragmentfont\\raggedright', 'RawFeature={-calt}']) {
        assert.ok(result.latex?.includes(expected), expected);
    }
    assert.equal(JSON.stringify(project), before);
});

test('LaTeX resolves root note inheritance before per-role programmatic overrides', async () => {
    for (const note of ['', '\nfont-note=Root']) {
        const result = await renderLatex(rootSettings('font-body=Root' + note), { bodyFont: 'Override' }, convert);
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.latex?.includes('\\setmainfont{Override}'));
        assert.ok(result.latex?.includes('\\newfontfamily\\notefont{Root}'));
    }
    const result = await renderLatex(rootSettings('font-body=Root\nfont-heading=Root\nfont-code=Root\n' +
        'font-fragment=Root\nfont-note=Root\nfont-code-ligatures=off'), {
        bodyFont: 'Body', headingFont: 'Heading', codeFont: 'Code', fragmentFont: 'Fragment',
        noteFont: 'Note', codeLigatures: true
    }, convert);
    assert.deepEqual(result.diagnostics, []);
    for (const value of ['{Body}', '{Heading}', '{Code}', '{Fragment}', '{Note}']) {
        assert.ok(result.latex?.includes(value), value);
    }
    assert.doesNotMatch(result.latex!, /RawFeature/);
});

test('LaTeX ligature options override settings in either direction', async () => {
    for (const configured of ['on', 'off']) {
        for (const codeLigatures of [undefined, true, false]) {
            const result = await renderLatex(rootSettings('font-code-ligatures=' + configured), { codeLigatures }, convert);
            assert.deepEqual(result.diagnostics, []);
            assert.equal(result.latex?.includes('RawFeature={-calt}'), !(codeLigatures ?? configured === 'on'));
            assert.ok(result.latex?.includes('Ligatures=Common,Contextuals=Alternate'));
            assert.doesNotMatch(result.latex!, /FakeSlant|FakeBold|ItalicFont=/);
        }
    }
});

test('LaTeX retains all invalid root settings before preparation and option overrides', async () => {
    const project = rootSettings('font-body=bad/path\nfont-body=Valid\nfont-note=\nfont-code-ligatures=no',
        fence('broken', 'const x = 1;'));
    project.publication.contributions[0].segments = []; // Would fail if preparation rendered it.
    let calls = 0;
    const result = await renderLatex(project, { bodyFont: 'Safe', noteFont: 'Safe', codeLigatures: true },
        async () => { calls++; return ''; });
    assert.equal(calls, 0);
    assert.equal(result.latex, undefined);
    assert.deepEqual(result.diagnostics.map(d => [d.path, d.line, d.column]),
        [['index.literate', 1, 0], ['index.literate', 3, 0], ['index.literate', 4, 0]]);
});

for (const source of [fence('a', '<<missing>>'), fence('a', '<<a>>'),
    fence('a', 'ok') + '\n![image](image.png)\n', fence('a'.repeat(513), 'ok')]) {
    test(`LaTeX preparation failures suppress converter and output: ${source.slice(0, 35)}`, async () => {
        let calls = 0;
        const result = await renderLatex(parse(source), {}, async () => { calls++; return ''; });
        assert.equal(calls, 0); assert.equal(result.latex, undefined); assert.ok(result.diagnostics.length);
    });
}

test('LaTeX catches synchronous/asynchronous converter failures and invalid return values', async () => {
    const converters: LatexConverter[] = [() => { throw new Error('sync'); },
        async () => { throw new Error('async'); }, async () => 7 as unknown as string];
    for (const converter of converters) {
        const result = await renderLatex(parse(''), {}, converter);
        assert.equal(result.latex, undefined); assert.equal(result.diagnostics[0].code, 'latex-conversion');
        assert.equal(result.diagnostics[0].line, 0); assert.equal(result.diagnostics[0].column, 0);
    }
});

test('LaTeX propagates highlighter reconstruction failures atomically', async () => {
    const project = parse(fence('broken', 'const x = 1;'));
    project.publication.contributions[0].segments = [];
    let calls = 0;
    const result = await renderLatex(project, {}, async () => { calls++; return ''; });
    assert.equal(calls, 0); assert.equal(result.latex, undefined);
    assert.equal(result.diagnostics[0].code, 'contribution-render-failed');
    assert.match(result.diagnostics[0].message, /reconstruct/);
});

test('LaTeX rejects reference modifiers before converter invocation', async () => {
    let calls = 0;
    const project = parse(fence('leaf', 'ok') + fence('caller', '<<leaf>>=+'));
    const result = await renderLatex(project, {}, async () => { calls++; return ''; });
    assert.equal(calls, 0); assert.equal(result.latex, undefined);
    assert.equal(result.diagnostics[0].code, 'invalid-reference-modifier');
});

const spacingCases = [
    { name: 'consecutive references', body: '<<leaf>>\n<<leaf>>', blocks: 0, blanks: 0 },
    { name: 'final reference', body: '<<leaf>>', blocks: 0, blanks: 0 },
    { name: 'indented references', body: '  <<leaf>>\n\t<<leaf>>', blocks: 0, blanks: 0 },
    { name: 'authored blank lines', body: '\n<<leaf>>\n\n  <<leaf>>\n', blocks: 3, blanks: 3 },
    { name: 'prefix and final reference', body: 'BEFORE\n  <<leaf>>', blocks: 1, blanks: 0 },
    { name: 'inline prefix and suffix', body: 'BEFORE <<leaf>> AFTER', blocks: 2, blanks: 0 },
    { name: 'reference before next code line', body: 'BEFORE <<leaf>>\nAFTER', blocks: 2, blanks: 0 }
];
for (const fixture of spacingCases) {
    test(`LaTeX reference spacing preserves only authored blank lines: ${fixture.name}`, async () => {
        let caller = '';
        const result = await renderLatex(parse(fence('caller', fixture.body) + fence('leaf', 'value')), {}, async document => {
            const chapter = document.blocks[0];
            assert.equal(chapter.t, 'Div');
            if (chapter.t !== 'Div') { throw new Error('Expected document'); }
            caller = raw(chapter.c[1].slice(0, 1));
            return raw(document.blocks);
        });
        assert.deepEqual(result.diagnostics, []);
        const blocks = [...caller.matchAll(/\\begin\{Verbatim\}[^\n]*\n([\s\S]*?)\\end\{Verbatim\}\n/g)].map(match => match[1]);
        assert.equal(blocks.length, fixture.blocks, caller);
        assert.equal(blocks.filter(block => block === '\n').length, fixture.blanks, caller);
        if (fixture.body.includes('BEFORE')) { assert.ok(caller.indexOf('BEFORE') < caller.indexOf('\\LitReferenceA{}')); }
        if (fixture.body.includes('AFTER')) { assert.ok(caller.indexOf('AFTER') > caller.indexOf('\\LitReferenceA{}')); }
    });
}

const ordinaryLiteral = '\\end{verbatim}\n\\end{Verbatim}\n\\<<literal>> % # $ & _ ^ ~ { }';
for (const [kind, source] of [
    ['fenced', '```text\n' + ordinaryLiteral + '\n```\n'],
    ['indented', ordinaryLiteral.split('\n').map(line => '    ' + line).join('\n') + '\n']
]) {
    test(`LaTeX safely owns ordinary ${kind} code before Pandoc`, async () => {
        const project = parse(source);
        const before = JSON.stringify(project);
        const result = await renderLatex(project, {}, async document => {
            assert.doesNotMatch(JSON.stringify(document), /"t":"CodeBlock"/);
            return raw(document.blocks);
        });
        assert.deepEqual(result.diagnostics, []);
        assert.equal(JSON.stringify(project), before);
        assert.ok(result.latex?.includes('\\textbackslash{}end\\textbraceleft{}verbatim\\textbraceright{}'));
        assert.ok(result.latex?.includes('\\textbackslash{}<<literal>>'));
        assert.doesNotMatch(result.latex!, /\\NormalTok|\\begin\{Shaded\}/);
    });
}

test('LaTeX ordinary-code walk retains nested containers and prose/inline code', async () => {
    const project = parse('Prose `inline`\n\n> - ```text\n>   \\end{verbatim}\n>   ```\n\n' +
        '1. ```text\n   \\end{verbatim}\n   ```\n');
    const result = await renderLatex(project, {}, async document => {
        const json = JSON.stringify(document);
        for (const type of ['Para', 'RawInline', 'Div', 'BlockQuote', 'BulletList', 'OrderedList']) {
            assert.ok(json.includes(`"t":"${type}"`), type);
        }
        assert.doesNotMatch(json, /"t":"CodeBlock"/);
        assert.ok(json.includes('LitInlineCode'));
        assert.equal((raw(document.blocks).match(/\\begin\{Verbatim\}/g) ?? []).length, 2);
        return raw(document.blocks);
    });
    assert.deepEqual(result.diagnostics, []);
});

test('LaTeX supports real Pandoc prose, ordinary code and nested contribution conversion',
    { skip: process.env.LITERATE_TEST_PANDOC !== '1' }, async () => {
        const source = '# Heading\n\n~~strike~~ **bold**\n\n- item\n\n```text\n' + ordinaryLiteral + '\n```\n\n' +
                    ordinaryLiteral.split('\n').map(line => '    ' + line).join('\n') + '\n\n' +
            fence('nested', 'const n = 1;').trimEnd().split('\n').map(line => '> ' + line).join('\n');
        const result = await renderLatex(parse(source), {}, async document => {
            const converted = spawnSync('pandoc', ['-f', 'json', '-t', 'latex', '--no-highlight',
                '--top-level-division=chapter'], { input: JSON.stringify(document), encoding: 'utf8', timeout: 10000 });
            assert.equal(converted.status, 0, converted.stderr);
            const heading = converted.stdout.indexOf(String.raw`\chapter{Heading}`);
            const destination = converted.stdout.indexOf(String.raw`\label{d-`);
            assert.ok(heading >= 0 && destination > heading);
            return converted.stdout;
        });
        assert.deepEqual(result.diagnostics, []);
        assert.doesNotMatch(result.latex!, /\\NormalTok|\\begin\{Shaded\}/);
        assert.equal((result.latex!.match(/\\textbackslash\{\}end\\textbraceleft\{\}verbatim/g) ?? []).length, 2);
        for (const expected of ['\\chapter{Heading}', '\\begin{quote}', '\\begin{Verbatim}', '\\begin{itemize}']) {
            assert.ok(result.latex?.includes(expected), expected);
        }
    });
