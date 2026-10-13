import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Token = require('markdown-it/lib/token');
import { parseProject, ParsedProject, PublicationContribution } from '../../engine';
import { preparePandoc, PandocBlock, PandocDocument, PandocInline } from '../../publication-pandoc';

function fence(header: string, body = ''): string {
    return '```' + header + '\n' + body + (body && !body.endsWith('\n') ? '\n' : '') + '```\n';
}

const parse = (text: string) => parseProject([{ path: 'index.literate', text }]);
const word = (c: string): PandocInline => ({ t: 'Str', c });
const para = (text: string): PandocBlock => ({ t: 'Para', c: [word(text)] });
const marker = (part: PublicationContribution): PandocBlock[] => [para(part.target)];

function prepared(project: ParsedProject, render = marker): PandocDocument {
    assert.deepEqual(project.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning'), []);
    const result = preparePandoc(project, render);
    assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning'), []);
    assert.ok(result.document);
    assert.deepEqual(result.document['pandoc-api-version'], [1, 23, 1]);
    assert.deepEqual(result.document.meta, {});
    return result.document;
}

function chapter(document: PandocDocument, index = 0) {
    const block = document.blocks[index];
    assert.equal(block.t, 'Div');
    if (block.t !== 'Div') { throw new Error('Expected document Div'); }
    assert.match(block.c[0][0], /^d-[0-9a-f]+$/);
    assert.deepEqual(block.c[0].slice(1), [[], []]);
    return { id: block.c[0][0], blocks: block.c[1] };
}

function rejected(project: ParsedProject, code: string, line: number, column = 0, path = 'index.literate') {
    assert.deepEqual(project.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning'), []);
    let calls = 0;
    const result = preparePandoc(project, part => { calls++; return marker(part); });
    assert.equal(calls, 0, 'all callbacks must be gated, including earlier contributions');
    assert.equal(result.document, undefined, 'no partial document may escape');
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code && diagnostic.path === path
        && diagnostic.line === line && diagnostic.column === column), JSON.stringify(result.diagnostics));
    return result.diagnostics;
}

test('Pandoc prepares empty projects and retains empty document destinations', () => {
    assert.deepEqual(prepared(parseProject([])).blocks, []);
    assert.deepEqual(chapter(prepared(parse(''))).blocks, []);
});

test('Pandoc models prose fragment uses and consumes explicit rail suffixes', () => {
    const project = parse('Before <<piece>> and <<piece>>[rail] after.\n\n' +
        fence('js : <<piece>>=', 'base') + fence('js : <<piece>>=+', 'addition'));
    const document = prepared(project), block = chapter(document).blocks[0];
    assert.equal(block.t, 'Para');
    if (block.t !== 'Para') { throw new Error('Expected paragraph'); }
    const links = block.c.filter((inline): inline is Extract<PandocInline, { t: 'Link' }> => inline.t === 'Link');
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(link => link.c[0][1]), [['lit-fragment-use'], ['lit-fragment-use']]);
    assert.deepEqual(links.map(link => new Map(link.c[0][2]).get('data-annotation')), ['none', 'rail']);
    assert.equal(new Set(links.map(link => new Map(link.c[0][2]).get('data-occurrence'))).size, 2);
    assert.deepEqual(links.map(link => link.c[1]), [[word('<<piece>>')], [word('<<piece>>')]]);
    assert.doesNotMatch(JSON.stringify(document), /\[rail\]/);
});

test('prose fragment uses respect Markdown boundaries and strict publication safety', () => {
    const project = parse('`<<piece>>` [label <<piece>>](https://example.org/<<piece>>) ' +
        '\\<<piece>>[rail] <<piece>>\n\n' + fence('text', '<<piece>>[rail]') + fence('js : <<piece>>=', 'base'));
    assert.equal(project.publication.proseReferences?.length, 1);
    assert.equal(project.publication.proseReferences?.[0].annotation, 'none');
    rejected(parse('Missing <<absent>>'), 'missing-fragment', 0);
    rejected(parse('# Important <<piece>>[rail]\n\n' + fence('js : <<piece>>=', 'base')), 'annotation-heading', 0);
});

test('Pandoc preserves supported blocks, inline nesting, breaks and list attributes', () => {
    const project = parse('# Title\n\n## Subtitle\n\n'
        + '*em **strong*** ~~gone~~ `x < y`\nsoft  \nhard\n\n---\n\n'
        + '- one\n- two\n\n3) three\n4) four\n\n7. seven\n');
    assert.deepEqual(chapter(prepared(project)).blocks, [
        { t: 'Header', c: [1, ['h-0069006e006400650078002e006c0069007400650072006100740065-007400690074006c0065', [], []], [word('Title')]] },
        { t: 'Header', c: [2, ['h-0069006e006400650078002e006c0069007400650072006100740065-007300750062007400690074006c0065', [], []], [word('Subtitle')]] },
        { t: 'Para', c: [
            { t: 'Emph', c: [word('em'), { t: 'Space' }, { t: 'Strong', c: [word('strong')] }] },
            { t: 'Space' }, { t: 'Strikeout', c: [word('gone')] }, { t: 'Space' },
            { t: 'Code', c: [['', [], []], 'x < y'] }, { t: 'SoftBreak' }, word('soft'),
            { t: 'LineBreak' }, word('hard')
        ] },
        { t: 'HorizontalRule' },
        { t: 'BulletList', c: [[{ t: 'Plain', c: [word('one')] }], [{ t: 'Plain', c: [word('two')] }]] },
        { t: 'OrderedList', c: [[3, { t: 'Decimal' }, { t: 'OneParen' }],
            [[{ t: 'Plain', c: [word('three')] }], [{ t: 'Plain', c: [word('four')] }]]] },
        { t: 'OrderedList', c: [[7, { t: 'Decimal' }, { t: 'Period' }],
            [[{ t: 'Plain', c: [word('seven')] }]]] }
    ]);
});

test('Pandoc replaces nested contributions in place with zero or multiple blocks', () => {
    const project = parse(['> Before', '>', '> - ```ts: <<piece>>=', '>   base', '>   ```',
        '>   after', '>', '> Closing', '', '1. ```js: <<piece>>=+', '   append', '   ```',
        '2. tail', ''].join('\n'));
    const before = JSON.stringify(project);
    const calls: PublicationContribution[] = [];
    const document = prepared(project, part => {
        calls.push(part);
        return part.kind === 'append' ? [] : [para('first'), para('second')];
    });
    assert.deepEqual(calls, project.publication.contributions);
    calls.forEach((part, index) => assert.equal(part, project.publication.contributions[index]));
    assert.deepEqual(calls.map(part => [part.kind, part.language, part.content]), [
        ['definition', 'ts', 'base\n'], ['append', 'js', 'append\n']
    ]);
    assert.deepEqual(chapter(document).blocks, [
        { t: 'BlockQuote', c: [para('Before'),
            { t: 'BulletList', c: [[para('first'), para('second'), { t: 'Plain', c: [word('after')] }]] },
            para('Closing')] },
        { t: 'OrderedList', c: [[1, { t: 'Decimal' }, { t: 'Period' }],
            [[], [{ t: 'Plain', c: [word('tail')] }]]] }
    ]);
    assert.equal(JSON.stringify(project), before, 'preparation must not mutate the parsed snapshot');
});

test('Pandoc delegates links outside the current publication', () => {
    const result = preparePandoc(parse('[Other](../other/index.literate#title)'), () => [], undefined,
        (href, source) => href === '../other/index.literate#title' && source === 'index.literate'
            ? '../other.pdf#title' : undefined);
    assert.deepEqual(result.diagnostics, []);
    assert.match(JSON.stringify(result.document), /\.\.\/other\.pdf#title/);
});

test('Pandoc accepts safe external links and resolves included documents with spaces and parent traversal', () => {
    const project = parseProject([
        { path: 'index.literate', text: '[Chapter](<chapters/a b.html> "chapter title")' },
        { path: 'chapters/a b.literate', text: '[Home](../index.literate)\n\n'
            + '[HTTP](http://example.org) [HTTPS](https://example.org/a?q=1#part "web title") [Mail](mailto:a@example.org)' }
    ]);
    const document = prepared(project);
    assert.deepEqual(project.documents.map(part => part.path), ['index.literate', 'chapters/a b.literate']);
    const home = chapter(document), other = chapter(document, 1);
    assert.notEqual(home.id, other.id);
    assert.deepEqual(home.blocks, [{ t: 'Para', c: [
        { t: 'Link', c: [['', [], []], [word('Chapter')], ['#' + other.id, 'chapter title']] }
    ] }]);
    assert.deepEqual(other.blocks, [
        { t: 'Para', c: [{ t: 'Link', c: [['', [], []], [word('Home')], ['#' + home.id, '']] }] },
        { t: 'Para', c: [
            { t: 'Link', c: [['', [], []], [word('HTTP')], ['http://example.org', '']] }, { t: 'Space' },
            { t: 'Link', c: [['', [], []], [word('HTTPS')], ['https://example.org/a?q=1#part', 'web title']] }, { t: 'Space' },
            { t: 'Link', c: [['', [], []], [word('Mail')], ['mailto:a@example.org', '']] }
        ] }
    ]);
    const shifted = prepared(parseProject(project.documents.map(part => ({ path: part.path, text: '\n# New\n\n' + part.source }))));
    assert.deepEqual(shifted.blocks.map((_, index) => chapter(shifted, index).id), [home.id, other.id]);
});

for (const href of ['index.literate?q=1',
    '../index.html', '/index.html', '//example.org/index.html', 'file.txt']) {
    test(`Pandoc rejects unsupported authored link ${href} before callbacks`, () => {
        rejected(parse(fence(': <<early>>=', 'ok') + '\n[bad](' + href + ')\n'),
            'unsupported-publication-link', 4);
    });
}

for (const href of ['javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/a', 'https://example.org/%0a',
    'https://example.org\\bad', 'https://', '%2e%2e/index.html', 'index.html%23heading', 'index.html%3fq=1', '%zz.html']) {
    test(`Pandoc validates actual link token destination ${href}`, () => {
        const project = parse(fence(': <<early>>=', 'ok') + '\n[safe](https://example.org)');
        const inline = project.documents[0].tokens.find(token => token.type === 'inline')!;
        // Markdown-it rejects javascript links as literal text; inject a real link token instead.
        inline.children!.find(token => token.type === 'link_open')!.attrSet('href', href);
        rejected(project, 'unsupported-publication-link', 4);
    });
}

test('Pandoc omits SETTINGS and preserves ordinary and escaped code without semantic rescanning', () => {
    const project = parse(fence('SETTINGS', 'theme=not-a-theme')
        + fence('text', '<<missing>>=+\n\\<<escaped>>\n\\input{evil}')
        + '\n    <<indented missing>>\n\n`<<inline missing>>`\n\n'
        + fence(': <<literal>>=', '\\<<not a dependency>>'));
    const calls: PublicationContribution[] = [];
    const document = prepared(project, part => { calls.push(part); return []; });
    assert.deepEqual(calls, project.publication.contributions);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].segments, [{ kind: 'text', text: '\\<<not a dependency>>\n' }]);
    assert.deepEqual(chapter(document).blocks, [
        { t: 'CodeBlock', c: [['', ['text'], []], '<<missing>>=+\n\\<<escaped>>\n\\input{evil}\n'] },
        { t: 'CodeBlock', c: [['', [], []], '<<indented missing>>\n'] },
        { t: 'Para', c: [{ t: 'Code', c: [['', [], []], '<<inline missing>>'] }] }
    ]);
});

test('Pandoc keeps HTML- and TeX-looking author prose as data, never RawBlock', () => {
    const document = prepared(parse('<script>alert(1)</script> \\input{evil} $x$ 50% & value_1 #hash'));
    assert.deepEqual(chapter(document).blocks, [{ t: 'Para', c: [
        word('<script>alert(1)</script>'), { t: 'Space' }, word('\\input{evil}'), { t: 'Space' },
        word('$x$'), { t: 'Space' }, word('50%'), { t: 'Space' }, word('&'), { t: 'Space' },
        word('value_1'), { t: 'Space' }, word('#hash')
    ] }]);
});

test('Pandoc wraps authored Mermaid assets in their stable destination', () => {
    const project = parse(fence('mermaid id=partition-flow', 'flowchart TD\nA-->B'));
    const result = preparePandoc(project, marker, () => [para('diagram')]);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.document);
    const blocks = chapter(result.document).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].t, 'Div');
    if (blocks[0].t === 'Div') {
        assert.equal(blocks[0].c[0][0], project.diagrams[0].target);
        assert.deepEqual(blocks[0].c[1], [para('diagram')]);
    }
});

for (const [name, text, code] of [
    ['image', '![alt](image.png)', 'unsupported-pandoc-token'],
    ['table', '| a | b |\n| --- | --- |\n| x | y |', 'unsupported-pandoc-token'],
    ['Mermaid fence', fence('mermaid', 'graph TD; A-->B'), 'unsupported-mermaid'],
    ['Mermaid contribution', fence('mermaid: <<diagram>>=', 'graph TD; A-->B'), 'unsupported-mermaid']
]) {
    test(`Pandoc late ${name} gates callbacks in every document`, () => {
        const project = parseProject([
            { path: 'index.literate', text: fence(': <<early>>=', 'ok') },
            { path: 'z.literate', text: fence(': <<later>>=', 'ok') + '\n' + text }
        ]);
        rejected(project, code, 4, 0, 'z.literate');
    });
}

for (const type of ['unknown_block', 'html_block', 'raw_block', 'latex_block', 'unknown_inline', 'html_inline', 'tex_inline']) {
    test(`Pandoc injected ${type} gates all callbacks even in the final document`, () => {
        const project = parseProject([
            { path: 'index.literate', text: fence(': <<early>>=', 'ok') },
            { path: 'z.literate', text: fence(': <<later>>=', 'ok') + '\nlate' }
        ]);
        const document = project.documents[1];
        const token = new Token(type, '', 0);
        token.content = '\\input{evil}';
        token.map = [4, 5];
        if (type.endsWith('_inline')) {
            document.tokens.find(item => item.type === 'inline')!.children = [token];
        } else { document.tokens = [...document.tokens, token]; }
        rejected(project, type.startsWith('unknown') ? 'unsupported-pandoc-token' : 'unsupported-raw-content', 4, 0, 'z.literate');
    });
}

test('Pandoc copies parse diagnostics and gates callbacks before further validation', () => {
    const project = parse(fence(': <<piece>>=', 'ok') + fence(': <<piece>>=', 'duplicate') + '\n![late](x.png)');
    assert.ok(project.diagnostics.length);
    const before = JSON.stringify(project);
    let calls = 0;
    const result = preparePandoc(project, () => { calls++; return []; });
    assert.equal(calls, 0);
    assert.equal(result.document, undefined);
    assert.deepEqual(result.diagnostics, project.diagnostics);
    assert.notEqual(result.diagnostics, project.diagnostics);
    result.diagnostics.forEach((diagnostic, index) => assert.notEqual(diagnostic, project.diagnostics[index]));
    assert.equal(JSON.stringify(project), before);
});

test('Pandoc rejects missing references in unused fragments at exact source coordinates', () => {
    const project = parse(fence(': <<early>>=', 'ok') + fence(': <<unused>>=', '  <<absent>>'));
    const diagnostics = rejected(project, 'missing-fragment', 4, 2);
    assert.equal(diagnostics.length, 1);
});

for (const modifier of ['=', '+', '=+']) {
    test(`Pandoc rejects reference modifier ${modifier} before callbacks`, () => {
        const project = parse(fence(': <<leaf>>=', 'ok') + fence(': <<unused>>=', 'x <<leaf>>' + modifier));
        assert.equal(rejected(project, 'invalid-reference-modifier', 4, 2).length, 1);
    });
}

test('Pandoc reports modifiers and missing targets together and still validates late tokens', () => {
    const project = parse(fence(': <<unused>>=', '<<missing>>=+') + '\n![late](x.png)');
    assert.deepEqual(rejected(project, 'missing-fragment', 1).map(diagnostic => diagnostic.code),
        ['invalid-reference-modifier', 'missing-fragment', 'unsupported-pandoc-token']);
});

test('Pandoc rejects cycles at the closing reference before callbacks', () => {
    const project = parse(fence(': <<a>>=', '<<b>>') + fence(': <<b>>=', 'x <<a>>'));
    assert.equal(rejected(project, 'fragment-cycle', 4, 2).length, 1);
});

test('Pandoc rejects an invalid contribution snapshot binding', () => {
    const project = parse(fence(': <<piece>>=', 'ok'));
    const document = project.documents[0];
    document.blocks = document.blocks.map(block => block.kind === 'contribution'
        ? { ...block, target: 'not-a-publication-target' } : block);
    assert.equal(rejected(project, 'invalid-publication-snapshot', 0).length, 1);
});

test('Pandoc callback failure suppresses all output and stops later nested and document callbacks', () => {
    const project = parseProject([
        { path: 'index.literate', text: fence(': <<first>>=', 'ok')
            + '\n> - ```text: <<fails>>=\n>   bad\n>   ```\n> - ```text: <<skipped>>=\n>   later\n>   ```\n' },
        { path: 'z.literate', text: fence(': <<last>>=', 'later') }
    ]);
    assert.deepEqual(project.diagnostics, []);
    const calls: PublicationContribution[] = [];
    const result = preparePandoc(project, part => {
        calls.push(part);
        if (calls.length === 2) { throw new Error('renderer exploded'); }
        return marker(part);
    });
    assert.deepEqual(calls, project.publication.contributions.slice(0, 2));
    assert.equal(result.document, undefined);
    assert.deepEqual(result.diagnostics, [{ ...project.publication.contributions[1].definition,
        code: 'contribution-render-failed', message: 'Contribution renderer failed: renderer exploded' }]);
    assert.deepEqual(project.publication.contributions[1].definition, { path: 'index.literate', line: 4, column: 4 });
});

test('Pandoc validates a 1000-deep doubling graph without expanding references', () => {
    const depth = 1000;
    const project = parse(Array.from({ length: depth }, (_, index) => fence(': <<n' + index + '>>=',
        index + 1 === depth ? 'leaf' : '<<n' + (index + 1) + '>><<n' + (index + 1) + '>>')).join(''));
    const calls: PublicationContribution[] = [];
    const document = prepared(project, part => { calls.push(part); return marker(part); });
    assert.equal(chapter(document).blocks.length, depth);
    assert.deepEqual(calls, project.publication.contributions);
    assert.equal(calls[0].content, '<<n1>><<n1>>\n');
    assert.equal(calls[depth - 1].content, 'leaf\n');
    assert.equal(calls.reduce((sum, part) => sum + part.segments.filter(segment => segment.kind === 'reference').length, 0),
        2 * (depth - 1));
});

test('Pandoc handles large flat paragraphs without spreading nodes into function arguments', () => {
    const document = prepared(parse('word '.repeat(100000)));
    const paragraph = chapter(document).blocks[0];
    assert.equal(paragraph.t, 'Para');
    if (paragraph.t !== 'Para') { throw new Error('Expected paragraph'); }
    assert.equal(paragraph.c.filter(inline => inline.t === 'Str').length, 100000);
});

test('Pandoc accepts large trusted contribution arrays without exceeding argument limits', () => {
    const blocks: PandocBlock[] = Array.from({ length: 150000 }, () => ({ t: 'HorizontalRule' }));
    const document = prepared(parse(fence(': <<piece>>=', 'value')), () => blocks);
    assert.equal(chapter(document).blocks.length, blocks.length);
    assert.equal(chapter(document).blocks[149999].t, 'HorizontalRule');
});

test('real Pandoc accepts prepared JSON and escapes author text while preserving trusted LaTeX blocks',
    { skip: process.env.LITERATE_TEST_PANDOC !== '1' }, () => {
        const project = parseProject([
            { path: 'index.literate', text: '# First\n\n[Second](<chapters/second chapter.html>)\n\n'
                + '\\input{AUTHOR_SENTINEL} 50% & value_1 $x$ #hash <b>literal</b>\n\n'
                + fence(': <<first>>=', 'first') },
            { path: 'chapters/second chapter.literate', text: '# Second\n\n[Home](../index.html)\n\n'
                + '> - *emphasis* and **strong**\n\n3) item\n\n'
                + fence('text', '\\input{CODE_SENTINEL}') + fence(': <<second>>=', 'second') }
        ]);
        let calls = 0;
        const document = prepared(project, () => [{ t: 'RawBlock', c: ['latex', '\\par TRUSTED_MARKER_' + (++calls) + '\\par'] }]);
        assert.equal(calls, 2);
        const result = spawnSync('pandoc', ['--from=json', '--to=latex', '--top-level-division=chapter'], {
            input: JSON.stringify(document), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\\chapter\{First\}/);
        assert.match(result.stdout, /\\chapter\{Second\}/);
        for (const index of [1, 2]) { assert.ok(result.stdout.includes('\\par TRUSTED_MARKER_' + index + '\\par')); }
        assert.ok(!result.stdout.includes('\\input{AUTHOR_SENTINEL}'));
        for (const escaped of ['\\textbackslash', '\\{', '\\}', '50\\%', '\\&', 'value\\_1', '\\$x\\$', '\\#hash']) {
            assert.ok(result.stdout.includes(escaped), escaped + '\n' + result.stdout);
        }
        assert.match(result.stdout, /literal/);
        assert.ok(result.stdout.includes('CODE\\_SENTINEL'));
                assert.ok(!result.stdout.includes('\\input{CODE_SENTINEL}'));
        assert.ok(result.stdout.includes(chapter(document).id));
        assert.ok(result.stdout.includes(chapter(document, 1).id));
    });
