import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import { generateProject, parseProject, ParsedDocument, SourceDocument } from '../../engine';

function fence(header: string, body = ''): string {
    return '```' + header + '\n' + body + (body && !body.endsWith('\n') ? '\n' : '') + '```\n';
}

function tokenCoverage(document: ParsedDocument): number[] {
    return document.blocks.flatMap(block => block.kind === 'contribution' ? [block.tokenIndex]
        : Array.from({ length: block.tokenEnd - block.tokenStart }, (_, index) => block.tokenStart + index));
}

function assertCoverage(document: ParsedDocument): void {
    assert.deepEqual(tokenCoverage(document), document.tokens.map((_, index) => index));
    for (const block of document.blocks) {
        if (block.kind === 'markdown') { assert.ok(block.tokenStart < block.tokenEnd); }
    }
}

test('shared parsing keeps prose, ordinary fences and contributions in one ordered token stream', () => {
    const source = '# Chapter\n\nOpening **prose**.\n\n'
        + fence('ts: <<piece>>=', 'const x = 1;') + '\nAn explanation.\n\n'
        + fence('text', 'ordinary code') + fence('ts: <<piece>>=+', 'use(x);') + '\nClosing prose.\n';
    const result = parseProject([{ path: './index.literate', text: source }]);
    assert.deepEqual(result.diagnostics, []);
    const document = result.documents[0];
    assert.equal(document.path, 'index.literate');
    assert.equal(document.source, source);
    assert.deepEqual(document.tokens, new MarkdownIt().parse(source, {}));
    assert.deepEqual(document.blocks.map(block => block.kind), ['markdown', 'contribution', 'markdown', 'contribution', 'markdown']);
    assertCoverage(document);
    const contributions = result.publication.contributions;
    const linked = document.blocks.filter(block => block.kind === 'contribution');
    assert.deepEqual(linked.map(block => block.kind === 'contribution' && block.target), contributions.map(part => part.target));
    for (const part of contributions) {
        assert.equal(document.tokens[part.tokenIndex].content, part.content);
    }
    const generated = generateProject([{ path: './index.literate', text: source }]);
    assert.deepEqual(result.inspection, generated.inspection);
    assert.deepEqual(result.publication, generated.publication);
});

test('nested contribution ranges preserve container tokens rather than pretending to be standalone Markdown', () => {
    const source = '> A quoted introduction.\r\n>\r\n> - ```ts: <<nested>>=\r\n>   \tconst n = 1;\r\n>   ```\r\n>\r\n> Closing text.';
    const result = parseProject([{ path: 'index.literate', text: source }]);
    const document = result.documents[0];
    assert.deepEqual(result.diagnostics, []);
    assert.equal(document.source, source);
    assertCoverage(document);
    assert.deepEqual(document.tokens, new MarkdownIt().parse(source, {}));
    assert.equal(document.tokens[0].type, 'blockquote_open');
    assert.equal(document.tokens[document.tokens.length - 1].type, 'blockquote_close');
    assert.equal(document.blocks.filter(block => block.kind === 'contribution').length, 1);
    assert.ok(document.tokens.some(token => token.type === 'bullet_list_open'));
});

test('parseProject does not apply theme, template availability, destination or dependency policies', () => {
    const documents = [{ path: 'index.literate', text:
        fence('SETTINGS', 'theme=not-a-theme\ntemplate=missing.html')
        + fence('ts: <<main.*>>= index.literate $ template=missing.source', '<<absent>>=\n<<cycle>>')
        + fence(': <<cycle>>=', '<<main.*>>') }];
    const parsed = parseProject(documents);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(parsed.inspection.templates, ['missing.html', 'missing.source']);
    const references = parsed.publication.contributions.flatMap(part => part.segments).filter(segment => segment.kind === 'reference');
    assert.equal(references.length, 3);
    assert.ok(references.some(segment => segment.kind === 'reference' && segment.resolution.kind === 'missing'));
    const generated = generateProject(documents);
    assert.deepEqual(generated.files, []);
    for (const message of ['theme', 'Missing template', 'Output collides', 'Missing fragment', 'Invalid definition operator', 'Fragment cycle']) {
        assert.ok(generated.diagnostics.some(diagnostic => diagnostic.message.toLowerCase().includes(message.toLowerCase())), message);
    }
    assert.deepEqual(parsed.publication, generated.publication);
    assert.deepEqual(parsed.inspection, generated.inspection);
});

test('syntax diagnostics link retained declarations only and leave rejected fences in Markdown ranges', () => {
    const source = fence('SETTINGS', 'template=../bad')
        + fence(': <<kept>>=', 'base') + fence(': <<kept>>=', 'duplicate')
        + fence(': <<orphan>>=+', 'orphan') + fence('ts: <<malformed>>', 'bad')
        + fence(': <<kept>>=+ forbidden.txt $', 'retained')
        + fence(': <<broken.*>>= ../outside.txt $', 'retained too');
    const result = parseProject([
        { path: '../outside.literate', text: '' }, { path: 'with-nul.literate', text: '\0' },
        { path: 'index.literate', text: source }, { path: './index.literate', text: 'duplicate input' }
    ]);
    assert.equal(result.documents.length, 1);
    assertCoverage(result.documents[0]);
    assert.equal(result.publication.contributions.length, 3);
    assert.equal(result.documents[0].blocks.filter(block => block.kind === 'contribution').length, 3);
    const markdownFenceBodies = result.documents[0].blocks.flatMap(block => block.kind === 'markdown'
        ? result.documents[0].tokens.slice(block.tokenStart, block.tokenEnd).filter(token => token.type === 'fence').map(token => token.content.trim()) : []);
    assert.deepEqual(markdownFenceBodies, ['template=../bad', 'duplicate', 'orphan', 'bad']);
    for (const message of ['Invalid source path', 'NUL', 'Duplicate source document', 'Invalid template path',
        'Duplicate fragment', 'Cannot append', 'Invalid fragment header', 'Append fragments cannot', 'Invalid output path']) {
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes(message)), message);
    }
});

test('parsing orders chapters and accepts empty documents and EOF fences without inventing tokens', () => {
    const documents: SourceDocument[] = [
        { path: 'a.literate', text: '' }, { path: 'z.literate', text: '```text: <<EOF>>=\nno closing fence' },
        { path: 'index.literate', text: '[Z](z.html)\n' }
    ];
    const parsed = parseProject(documents);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(parsed.documents.map(document => document.path), ['index.literate', 'z.literate', 'a.literate']);
    for (const document of parsed.documents) { assertCoverage(document); }
    assert.deepEqual(parsed.documents[2].tokens, []);
    assert.deepEqual(parsed.documents[2].blocks, []);
    assert.equal(parsed.publication.contributions[0].content, 'no closing fence');
    assert.deepEqual(parseProject([...documents].reverse()), parsed);
    assert.deepEqual(parseProject([]), {
        documents: [], diagnostics: [], inspection: { documents: [], templates: [], fragments: [] },
        publication: { documents: [], fragments: [], contributions: [] }
    });
});

test('parsing does not expand an exponentially growing fragment graph', () => {
    let source = fence(': <<part0>>=', 'x');
    for (let index = 1; index <= 40; index++) {
        const reference = '<<part' + (index - 1) + '>>';
        source += fence(': <<part' + index + '>>=', reference + reference);
    }
    const parsed = parseProject([{ path: 'index.literate', text: source }]);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.publication.contributions.length, 41);
    assert.equal(parsed.publication.contributions[40].content, '<<part39>><<part39>>\n');
});

test('generation policy checkpoints preserve the pre-extraction ordered diagnostics', () => {
    const documents = [
        { path: '../bad.literate', text: '' }, { path: 'blocked.literate', text: '\0' },
        { path: 'index.literate', text: fence('SETTINGS', 'theme=not-a-theme\ntemplate=missing.html')
            + fence(': <<main.*>>= blocked.literate $ template=missing.source', '<<absent>>=')
            + fence(': <<main.*>>=+ forbidden.txt $', 'append') }
    ];
    const supplied = Object.fromEntries([['../bad.template', 'x']]);
    const result = generateProject(documents, supplied);
    const diagnostic = (path: string, line: number, message: string) => ({ path, line, column: 0, message });
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, [
        diagnostic('../bad.literate', 0, 'Invalid source path'),
        diagnostic('blocked.literate', 0, 'Invalid output path or source text: NUL characters are not allowed'),
        diagnostic('../bad.template', 0, 'Invalid template path'),
        diagnostic('index.literate', 1, 'Unknown theme: not-a-theme'),
        diagnostic('index.literate', 2, 'Missing template: missing.html'),
        diagnostic('index.literate', 4, 'Output collides with input: blocked.literate'),
        diagnostic('index.literate', 4, 'Missing template: missing.source'),
        diagnostic('index.literate', 7, 'Append fragments cannot specify output or template'),
        diagnostic('index.literate', 5, 'Invalid definition operator on reference: absent'),
        { ...diagnostic('index.literate', 5, 'Missing fragment: absent'), code: 'missing-fragment' }
    ]);
    assert.deepEqual(parseProject(documents).diagnostics, [
        result.diagnostics[0], result.diagnostics[1], result.diagnostics[7]
    ]);
});

test('parse calls own their mutable token objects without leaking mutations to later calls', () => {
    const documents = [{ path: 'index.literate', text: '# Title\n\n' + fence(': <<piece>>=', 'value') }];
    const first = parseProject(documents);
    first.documents[0].tokens[1].content = 'changed';
    first.publication.contributions[0].content = 'changed';
    const second = parseProject(documents);
    assert.equal(second.documents[0].tokens[1].content, 'Title');
    assert.equal(second.publication.contributions[0].content, 'value\n');
});
