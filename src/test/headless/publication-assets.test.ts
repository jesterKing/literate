import assert = require('node:assert/strict');
import { test } from 'node:test';
import { assetInput, assetKey, collectAssets, maximumAssetBytes, planAssets } from '../../publication-assets';
import { parseProject } from '../../engine';
import { PublicationAsset, PandocBlock } from '../../publication-pandoc';
import { renderLatex } from '../../publication-latex';

const image = (source: string, caption = 'Caption'): PublicationAsset => ({
    kind: 'image', source, caption, at: { path: 'chapters/book.literate', line: 3, column: 0 }
});
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ff00', 'hex');
const pdf = Buffer.from('%PDF-1.4\n');
const collect = (text: string) => collectAssets(parseProject([{ path: 'chapters/book.literate', text }]));

for (const source of ['https://example.org/a.png', '//host/a.png', '/a.png', '../a.png?x',
    '../a.png#x', '../../a.png', '%2e%2e/%2e%2e/a.png', 'C:/a.png', 'a\\b.png',
    'a%3fb.png', '%2fa.png', 'a%00.png', 'a%7f.png', '%zz', '']) {
    test(`asset rejects unsafe source ${JSON.stringify(source)}`, () => {
        assert.throws(() => assetInput(image(source)));
    });
}
test('assets resolve chapter-relative paths and decode exactly once', () => {
    assert.equal(assetInput(image('../images/hello%20world.png')), 'images/hello world.png');
    assert.equal(assetInput(image('./diagram.png')), 'chapters/diagram.png');
});
test('assets deduplicate content and reads while retaining every protected input', async () => {
    const requests = [image('one.png'), image('one.png', 'Other caption'), image('two.png'), image('three.jpg'), image('four.pdf')];
    const reads: string[] = [];
    const io = { async requireFile() {}, async read(name: string) {
        reads.push(name); return name.endsWith('.png') ? png : name.endsWith('.jpg') ? jpeg : pdf;
    } };
    const plan = await planAssets(requests, 'exports/book.tex', io);
    assert.equal(plan.files.length, 3);
    assert.equal(reads.length, 4);
    assert.deepEqual(plan.inputs, reads);
    assert.equal(plan.paths.get(assetKey(requests[0])), plan.paths.get(assetKey(requests[2])));
    for (const file of plan.files) {
        assert.match(file.path, /^exports\/lit-assets-[a-f0-9]{64}\/[a-f0-9]{64}\.(png|jpg|pdf)$/);
    }
    const moved = await planAssets(requests, 'elsewhere/book.tex', io);
    assert.deepEqual(moved.paths, plan.paths);
    const other = await planAssets(requests, 'exports/other.tex', io);
    assert.notDeepEqual(other.paths, plan.paths);
});
for (const [name, bytes] of [['bad.svg', Buffer.from('<svg/>')], ['wrong.png', pdf],
    ['empty.png', Buffer.alloc(0)], ['large.png', Buffer.alloc(maximumAssetBytes + 1)]] as const) {
    test(`asset validates signature and size: ${name}`, async () => {
        await assert.rejects(planAssets([image(name)], 'book.tex', {
            async requireFile() {}, async read() { return bytes; }
        }), /chapters\/book.literate:4:/);
    });
}
test('asset request and unique byte budgets are bounded', async () => {
    let calls = 0;
    const bytes = Buffer.alloc(maximumAssetBytes); png.copy(bytes);
    const io = { async requireFile() { calls++; }, async read() { bytes[8] = calls; return bytes; } };
    await assert.rejects(planAssets(Array(1025).fill(image('a.png')), 'book.tex', io), /1024/);
    assert.equal(calls, 0);
    await assert.rejects(planAssets(Array.from({ length: 5 }, (_, i) => image(`${i}.png`)), 'book.tex', io), /128 MiB/);
});
test('collection preserves nested images, titles, captions and source locations', () => {
    const result = collect('# Book\n\n- ![Alt](a.png "Title")\n\n> ![Plain caption](b.pdf)\n');
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.assets.map(asset => [asset.source, asset.caption, asset.at.line]), [
        ['a.png', 'Title', 2], ['b.pdf', 'Plain caption', 4]
    ]);
});
test('collection decodes caption entities and escaped punctuation while preferring titles', () => {
    const result = collect(String.raw`![A &amp; B \*star\* \_name\_ \{value\}](a.png)

![A &amp; B \*star\*](b.png "Title")`);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.assets.map(asset => asset.caption), ['A & B *star* _name_ {value}', 'Title']);
});
for (const text of ['Text ![inline](a.png)', '![*formatted*](a.png)', '![a](a.png) ![b](b.png)',
    '```mermaid extra-options\ngraph TD; A-->B\n```', '![ok](a.png)\n\n| A | B |\n| --- | --- |\n| a | b |']) {
    test(`unsupported content prevents asset collection: ${text}`, () => {
        const result = collect(text);
        assert.ok(result.diagnostics.length);
        assert.deepEqual(result.assets, []);
    });
}
function raw(blocks: PandocBlock[]): string {
    return blocks.map(block => block.t === 'RawBlock' ? block.c[1]
        : block.t === 'Div' ? raw(block.c[1]) : block.t === 'BlockQuote' ? raw(block.c)
        : block.t === 'BulletList' ? block.c.map(raw).join('\n') : '').join('\n');
}
test('LaTeX fits both dimensions, measures escaped captions, and honors all margins', async () => {
    const project = parseProject([{ path: 'book.literate', text: '> ![Caption & 100%](a.pdf)' }]);
    const file = `lit-assets-${'a'.repeat(64)}/${'b'.repeat(64)}.pdf`;
    const result = await renderLatex(project, { paper: 'A5', marginTopMm: 18, marginRightMm: 16,
        marginBottomMm: 22, marginLeftMm: 20, assetPath: () => file }, async doc => raw(doc.blocks));
    assert.deepEqual(result.diagnostics, []);
    for (const expected of ['a5paper', 'top=18mm', 'right=16mm', 'bottom=22mm', 'left=20mm',
        '\\parbox{\\linewidth}', '\\textheight-\\ht\\LitCaptionBox-\\dp\\LitCaptionBox-24pt',
        'width=\\linewidth,height=\\LitImageHeight,keepaspectratio', `\\LitImage{${file}}{Caption \\& 100\\%}`]) {
        assert.ok(result.latex!.includes(expected), expected);
    }
});
test('LaTeX preserves Mermaid natural size and only shrinks at page bounds', async () => {
    const project = parseProject([{ path: 'book.literate', text:
        '```mermaid\nflowchart TD\nA --> B\n```' }]);
    const file = `lit-assets-${'a'.repeat(64)}/${'b'.repeat(64)}.pdf`;
    const result = await renderLatex(project, { assetPath: () => file }, async doc => raw(doc.blocks));
    assert.deepEqual(result.diagnostics, []);
    for (const expected of [`\\LitDiagram{${file}}`,
        '\\sbox{\\LitDiagramBox}{\\includegraphics{#1}}',
        '\\ifdim\\wd\\LitDiagramBox>\\linewidth',
        '\\includegraphics[width=\\linewidth]{#1}',
        '\\ifdim\\dimexpr\\ht\\LitDiagramBox+\\dp\\LitDiagramBox\\relax>\\LitDiagramHeight',
        '\\includegraphics[height=\\LitDiagramHeight]{#1}']) {
        assert.ok(result.latex!.includes(expected), expected);
    }
    assert.ok(!result.latex!.includes(`\\LitImage{${file}}`));
});
test('LaTeX escapes decoded caption entities and punctuation exactly once', async () => {
    const project = parseProject([{ path: 'book.literate',
        text: String.raw`![A &amp; B \*star\* \_name\_ \{value\} 100%](a.pdf)` }]);
    const file = `lit-assets-${'a'.repeat(64)}/${'b'.repeat(64)}.pdf`;
    const result = await renderLatex(project, { assetPath: () => file }, async doc => raw(doc.blocks));
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.latex!.includes(`\\LitImage{${file}}{A \\& B *star* \\_name\\_ \\{value\\} 100\\%}`));
});
test('unsafe adapter paths and oversized captions fail before conversion', async () => {
    for (const [caption, file] of [['caption', '../escape.pdf'], ['x'.repeat(4097),
        `lit-assets-${'a'.repeat(64)}/${'b'.repeat(64)}.pdf`]]) {
        let calls = 0;
        const result = await renderLatex(parseProject([{ path: 'book.literate', text: `![${caption}](a.pdf)` }]),
            { assetPath: () => file }, async () => { calls++; return ''; });
        assert.equal(calls, 0); assert.ok(result.diagnostics.length);
    }
});
