import assert = require('node:assert/strict');
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { generateProject, parseProject, SourceDocument } from '../../engine';
import { preparePandoc, PandocBlock, PandocDocument } from '../../publication-pandoc';
import { renderLatex } from '../../publication-latex';
const source = (text: string, path = 'index.literate'): SourceDocument => ({ path, text });
const fence = (body: string) => '```ts : <<piece>>=\n' + body + '\n```\n';
function blocks(document: PandocDocument): PandocBlock[] {
    const result: PandocBlock[] = [];
    function visit(block: PandocBlock): void {
        result.push(block);
        if (block.t === 'Div') { block.c[1].forEach(visit); }
        if (block.t === 'BlockQuote') { block.c.forEach(visit); }
        if (block.t === 'BulletList') { block.c.forEach(item => item.forEach(visit)); }
        if (block.t === 'OrderedList') { block.c[1].forEach(item => item.forEach(visit)); }
    }
    document.blocks.forEach(visit);
    return result;
}
function target(slug: string, path = 'index.literate'): string {
    const hex = (value: string) => value.split('').map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    return 'h-' + hex(path) + '-' + hex(slug);
}
function prepare(sources: SourceDocument[]): PandocDocument {
    const project = parseProject(sources), before = JSON.stringify(project);
    const result = preparePandoc(project, () => [{ t: 'Para', c: [{ t: 'Str', c: 'CONTRIBUTION' }] }]);
    assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning'), []);
    assert.equal(JSON.stringify(project), before);
    assert.ok(result.document);
    return result.document;
}
function headingIds(document: PandocDocument): string[] {
    return blocks(document).flatMap(block => block.t === 'Header' ? [block.c[1][0]] : []);
}
function destinations(document: PandocDocument): string[] {
    return blocks(document).flatMap(block => block.t === 'Para' || block.t === 'Plain'
        ? block.c.flatMap(inline => inline.t === 'Link' ? [inline.c[2][0]] : []) : []);
}
function reject(text: string, code: string, line = 4): void {
    const project = parseProject([source(fence('ok') + '\n' + text)]);
    let calls = 0;
    const result = preparePandoc(project, () => { calls++; return []; });
    assert.equal(calls, 0);
    assert.equal(result.document, undefined);
    assert.ok(result.diagnostics.some(d => d.code === code && d.path === 'index.literate'
        && d.line === line && d.column === 0), JSON.stringify(result.diagnostics));
}
for (const href of ['#absent', 'index.html#absent', 'index.literate#absent', '#Title', '#caf%25C3%25A9']) {
    test(`missing heading diagnostic: ${href}`, () => {
        reject('[bad](' + href + ')\n\n# title\n\n# café', 'missing-publication-heading');
    });
}
function checkHeadingLatex(latex: string, document: PandocDocument): void {
    for (const id of headingIds(document)) {
        assert.ok(latex.includes('\\label{' + id + '}'), latex);
        assert.ok(latex.includes('\\hyperref[' + id + ']'), latex);
    }
    assert.ok(!latex.includes('\\input{HEADING_ATTACK}'));
    assert.ok(!latex.includes('\\input{TITLE_ATTACK}'));
    for (const escaped of ['\\textbackslash', '\\{', '\\}', '\\&', '50\\%']) {
        assert.ok(latex.includes(escaped), escaped + '\n' + latex);
    }
}
for (const [title, slug] of [
    ['A *bold **inside*** and `x_y` [Label](https://example.org/ignored)', 'a-bold-inside-and-x_y-label'],
    ['Café 東京 Ελληνικά', 'café-東京-ελληνικά'], ['Cafe\u0301', 'café'],
    ['A &amp; B \\*literal\\*', 'a-b-literal'], ['~~Gone~~: A.B/C+D!', 'gone-abcd'],
    ['  A   B -- C_D  ', 'a-b----c_d'], ['😀 ♥ !!!', 'section'], ['', 'section'],
    ['__proto__', 'proto'], ['constructor', 'constructor'], ['İ', 'i\u0307'],
    ['`\\input{BAD}% & $ # ^ ~`', 'inputbad'], ['𝒜 𐐀', '𝒜-𐐨']
]) {
    test(`publication heading slug from ${JSON.stringify(title)}`, () => {
        const document = prepare([source('# ' + title + '\n\n[go](#' + encodeURIComponent(slug) + ')')]);
        assert.deepEqual(headingIds(document), [target(slug)]);
        assert.deepEqual(destinations(document), ['#' + target(slug)]);
        assert.match(headingIds(document)[0], /^h-[0-9a-f]+-[0-9a-f]+$/);
    });
}
for (const [title, slug] of [['J\u030c', '\u01f0'], ['A.\u0301', '\u00e1']]) {
    test(`final slug normalization resolves both fragment forms for ${title}`, () => {
        const links = [slug, slug.normalize('NFD')].map(value =>
            '[go](#' + encodeURIComponent(value) + ')').join(' ');
        const document = prepare([source('# ' + title + '\n\n' + links)]);
        assert.deepEqual(headingIds(document), [target(slug)]);
        assert.deepEqual(destinations(document), ['#' + target(slug), '#' + target(slug)]);
        assert.deepEqual(headingIds(prepare([source('# ' + slug)])), headingIds(document));
    });
}
for (const [title, slug] of [['J\u030c', '\u01f0'], ['A.\u0301', '\u00e1']]) {
    test(`final slug normalization groups canonical duplicates for ${title}`, () => {
        const headings = '# ' + title + '\n\n# ' + slug;
        const links = [slug, slug.normalize('NFD')].flatMap(value => [1, 2].map(ordinal =>
            '[go](#' + encodeURIComponent(value) + '-' + ordinal + ')')).join(' ');
        const document = prepare([source(headings + '\n\n' + links)]);
        const ids = [target(slug + '-1'), target(slug + '-2')];
        assert.deepEqual(headingIds(document), ids);
        assert.deepEqual(destinations(document), [...ids, ...ids].map(id => '#' + id));
        for (const value of [slug, slug.normalize('NFD')]) {
            const project = parseProject([source(headings + '\n\n[bad](#' + encodeURIComponent(value) + ')')]);
            const result = preparePandoc(project, () => { throw new Error('must not render'); });
            assert.equal(result.document, undefined);
            assert.deepEqual(result.diagnostics.map(d => [d.code, d.line]), [['ambiguous-publication-heading', 4]]);
            assert.ok(result.diagnostics[0].message.endsWith('use #' + slug + '-1, #' + slug + '-2'));
        }
    });
}
test('heading formatting survives and setext identities match ATX', () => {
    const title = '*Strong* and `code` [label](https://example.org)';
    const atx = prepare([source('# ' + title)]);
    const setext = prepare([source(title + '\n====')]);
    assert.deepEqual(headingIds(atx), headingIds(setext));
    const header = blocks(atx).find(block => block.t === 'Header');
    assert.ok(header?.t === 'Header');
    assert.deepEqual(header.c[2].map(inline => inline.t), ['Emph', 'Space', 'Str', 'Space', 'Code', 'Space', 'Link']);
});
test('generated HTML has no heading IDs; publication does not change HTML behavior', () => {
    const result = generateProject([source('# Same\n\n# Same\n\n[go](#same)')]);
    assert.deepEqual(result.diagnostics, []);
    const html = result.files.find(file => file.path === 'index.html')!.content;
    assert.equal((html.match(/<h1>Same<\/h1>/g) ?? []).length, 2);
    assert.ok(html.includes('href="#same"'));
});
test('duplicates reserve natural suffixes and allocate deterministic unique IDs', () => {
    const text = '# Foo\n\n## Foo\n\n# Foo-1\n\n# Foo-2\n\n# !!!\n\n# 😀\n\n# section-1\n\n'
        + '[a](#foo-3) [b](#foo-4) [c](#foo-1) [d](#section-2) [e](#section-3)';
    const document = prepare([source(text)]);
    assert.deepEqual(headingIds(document), ['foo-3', 'foo-4', 'foo-1', 'foo-2', 'section-2', 'section-3', 'section-1'].map(s => target(s)));
    assert.equal(new Set(headingIds(document)).size, 7);
    assert.deepEqual(destinations(document), ['foo-3', 'foo-4', 'foo-1', 'section-2', 'section-3'].map(s => '#' + target(s)));
    const unicode = prepare([source('# Café\n\n# Cafe\u0301\n\n[a](#café-1) [b](#cafe%CC%81-2)')]);
    assert.deepEqual(headingIds(unicode), ['café-1', 'café-2'].map(s => target(s)));
    assert.deepEqual(destinations(unicode), headingIds(unicode).map(id => '#' + id));
});
test('repeated Foo and Foo-1 reserve literal Foo-1-1 without target collisions', () => {
    const headings = '# Foo\n\n# Foo\n\n# Foo-1\n\n# Foo-1\n\n# Foo-1-1';
    const slugs = ['foo-2', 'foo-3', 'foo-1-2', 'foo-1-3', 'foo-1-1'];
    const links = slugs.map(slug => '[go](#' + slug + ')').join(' ');
    const document = prepare([source(headings + '\n\n' + links)]);
    assert.deepEqual(headingIds(document), slugs.map(slug => target(slug)));
    assert.equal(new Set(headingIds(document)).size, slugs.length);
    assert.deepEqual(destinations(document), headingIds(document).map(id => '#' + id));
    const project = parseProject([source(headings + '\n\n[bad](#foo) [bad](#foo-1)')]);
    const result = preparePandoc(project, () => { throw new Error('must not render'); });
    assert.equal(result.document, undefined);
    assert.deepEqual(result.diagnostics.map(d => [d.code, d.line, d.column]), [
        ['ambiguous-publication-heading', 10, 0], ['ambiguous-publication-heading', 10, 0]
    ]);
    assert.ok(result.diagnostics[0].message.endsWith('use #foo-2, #foo-3'));
    assert.ok(result.diagnostics[1].message.endsWith('use #foo-1-2, #foo-1-3'));
});
test('cross-document headings resolve before rendering with safe path aliases', () => {
    const document = prepare([
        source('[source](<chapters/a b.literate#same>) [html](chapters/a%20b.html#same)\n\n# Same'),
        source('[back](../index.html#same) [self](#same)\n\n# Same', 'chapters/a b.literate')
    ]);
    const home = target('same'), other = target('same', 'chapters/a b.literate');
    assert.deepEqual(headingIds(document), [home, other]);
    assert.deepEqual(destinations(document), ['#' + other, '#' + other, '#' + home, '#' + other]);
    const shifted = prepare([source('# Unrelated\n\n# Same', 'chapters/a b.literate'), source('\n\n# Same')]);
    assert.ok(headingIds(shifted).includes(home));
    assert.ok(headingIds(shifted).includes(other));
    const reordered = prepare([source('# Same', 'z.literate'), source('# Same', 'a.literate')]);
    assert.deepEqual(headingIds(reordered), [target('same', 'a.literate'), target('same', 'z.literate')]);
});
test('hostile path characters and astral Unicode remain injective safe data', () => {
    const paths = ['a-b.literate', 'a/b.literate', 'é.literate', '𝒜.literate', 'a%20b.literate', 'a b.literate', 'x{y}&_.literate'];
    const links = paths.map(path => '[go](<' + encodeURI(path) + '#safe>)').join(' ');
    const document = prepare([source(links), ...paths.map(path => source('# Safe', path))]);
    assert.equal(new Set(headingIds(document)).size, paths.length);
    assert.deepEqual(destinations(document), paths.map(path => '#' + target('safe', path)));
    headingIds(document).forEach(id => assert.match(id, /^h-[0-9a-f]+-[0-9a-f]+$/));
});
test('nested headings and contribution slots retain the full container stream', () => {
    const text = '[before](#nested) [after](#after)\n\n> - ## Nested\n>\n'
        + '>   ```ts : <<piece>>=\n>   # not a heading\n>   ```\n>\n>   ### After\n>\n>   tail\n';
    const document = prepare([source(text)]);
    assert.deepEqual(headingIds(document), [target('nested'), target('after')]);
    assert.deepEqual(destinations(document), headingIds(document).map(id => '#' + id));
    const quote = blocks(document).find(block => block.t === 'BlockQuote');
    assert.ok(quote?.t === 'BlockQuote');
    const list = quote.c[0];
    assert.ok(list.t === 'BulletList');
    assert.deepEqual(list.c[0].map(block => block.t), ['Header', 'Para', 'Header', 'Para']);
    assert.deepEqual(list.c[0][1], { t: 'Para', c: [{ t: 'Str', c: 'CONTRIBUTION' }] });
    assert.deepEqual(headingIds(prepare([source('```text\n# Fake\n```\n\n    # Also fake')])), []);
});
for (const href of ['#', 'index.html#', '#bad%00', '#bad%0a', '#bad%7f', '#bad%5c', '#%zz',
    '#a#b', '#a?b', '#a%20b', 'index.html?q=1#title', '../index.html#title',
    '/index.html#title', '//host/index.html#title', 'index.html%23title', 'index.html%3fq=1#title']) {
    test(`unsupported heading URL diagnostic: ${href}`, () => {
        const project = parseProject([source(fence('ok') + '\n[bad](https://example.org)')]);
        const inline = project.documents[0].tokens.find(token => token.type === 'inline')!;
        inline.children!.find(token => token.type === 'link_open')!.attrSet('href', href);
        let calls = 0;
        const result = preparePandoc(project, () => { calls++; return []; });
        assert.equal(calls, 0); assert.equal(result.document, undefined);
        assert.deepEqual(result.diagnostics.map(d => [d.code, d.line, d.column]), [['unsupported-publication-link', 4, 0]]);
    });
}
test('missing included document diagnostics cover whole and heading links', () => {
    reject('[bad](missing.html)', 'missing-publication-document');
    reject('[bad](missing.literate#title)', 'missing-publication-document');
});
test('authored unsafe heading URLs are rejected before callbacks', () => {
    for (const href of ['#bad%00', '#bad%0a', '#bad%5c', 'index.html?q=1#title',
        '../index.html#title', '//host/index.html#title']) {
        reject('[bad](' + href + ')\n\n# Title', 'unsupported-publication-link');
    }
});
test('ambiguous bases list allocated alternatives at the source link', () => {
    const project = parseProject([source('[bad](#foo)\n\n# Foo\n\n# Foo\n\n# Foo-1')]);
    const result = preparePandoc(project, () => []);
    assert.equal(result.document, undefined);
    assert.deepEqual(result.diagnostics.map(d => [d.code, d.line]), [['ambiguous-publication-heading', 0]]);
    assert.match(result.diagnostics[0].message, /use #foo-2, #foo-3/);
    reject('[bad](index.html#foo)\n\n# Foo\n\n# Foo', 'ambiguous-publication-heading');
});
test('heading indexing does not bypass unsupported inline content or raw attributes', () => {
    reject('# ![image](asset.png)', 'unsupported-pandoc-token');
    reject('# [bad](#absent)', 'missing-publication-heading');
    const project = parseProject([source('# Safe\n\n[go](#safe)')]);
    project.documents[0].tokens[0].attrSet('id', '\\input{ATTACK}');
    const result = preparePandoc(project, () => []);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(headingIds(result.document!), [target('safe')]);
});
test('LaTeX adapter gates missing, ambiguous and unsupported heading links before converter', async () => {
    for (const [text, code] of [
        ['[go](#absent)', 'missing-publication-heading'],
        ['[go](#same)\n\n# Same\n\n# Same', 'ambiguous-publication-heading'],
        ['[go](index.html?q=1#same)', 'unsupported-publication-link']
    ]) {
        let calls = 0;
        const result = await renderLatex(parseProject([source(fence('ok') + '\n' + text)]), {}, async () => {
            calls++; return 'must not happen';
        });
        assert.equal(calls, 0); assert.equal(result.latex, undefined);
        assert.ok(result.diagnostics.some(d => d.code === code));
    }
});
test('real Pandoc preserves heading destinations, links and escaped inline author data',
    { skip: process.env.LITERATE_TEST_PANDOC !== '1' }, () => {
        const document = prepare([
            source('[next](two.html#café)\n\n# `\\input{HEADING_ATTACK}` & 50% _value_\n\n[me](#inputheading_attack-50-value "\\\\input{TITLE_ATTACK}")'),
            source('# Café\n\n[back](index.literate#inputheading_attack-50-value)', 'two.literate')
        ]);
        for (const format of ['json', 'latex']) {
            const result = spawnSync('pandoc', ['--from=json', '--to=' + format, '--top-level-division=chapter'], {
                input: JSON.stringify(document), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
            });
            assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
            if (format === 'json') {
                assert.deepEqual(JSON.parse(result.stdout).blocks, document.blocks);
            } else { checkHeadingLatex(result.stdout, document); }
        }
    });
