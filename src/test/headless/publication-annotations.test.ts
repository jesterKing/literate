import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import { generateProject, parseProject } from '../../engine';
import { collectAnnotations, parseAnnotationBody, resolveTermHref, termByTarget } from '../../publication-annotations';

function fence(header: string, body = '', marker = '```'): string {
    return `${marker}${header}\n${body}\n${marker}\n`;
}
function collect(text: string) {
    return collectAnnotations([{ path: 'index.literate', text, tokens: new MarkdownIt().parse(text, {}) }]);
}

test('empty and ordinary documents retain legacy behavior with empty annotation arrays', () => {
    const text = '# Ordinary\n\n' + fence('TERMish', '[not a use](term:no)') + fence('js', 'TERM key "Title"');
    assert.deepEqual(collect(text), { terms: [], notes: [], uses: [], diagnostics: [] });
    assert.deepEqual(parseProject([{ path: 'index.literate', text }]).annotations, collect(text));
    assert.deepEqual(generateProject([{ path: 'index.literate', text }]).diagnostics, []);
});

test('forward cross-document links, headings and nested lists expose exact occurrence indexes', () => {
    const documents = [
        { path: 'index.literate', text: '# [A](term:A) and [A again](term:%41)\n\n- nested\n  - [B](term:B)\n' },
        { path: 'defs.literate', text: fence('TERM A "A title"', '- **Strong** and *em* with `code`\n  - [B](term:B)')
            + fence('TERM B "B title"', 'Paragraph with [ordinary](https://example.org).')
            + fence('NOTE', '[A](term:A)') }
    ];
    const parsed = parseProject(documents);
    const model = parsed.annotations;
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(model.terms.length, 2);
    assert.equal(model.notes[0].number, 1);
    assert.equal(model.uses.length, 5);
    assert.ok(model.uses.every(use => use.resolution === 'resolved'));
    for (const use of model.uses) {
        const document = parsed.documents.find(item => item.path === use.owner);
        const bodyOwner = [...model.terms, ...model.notes].find(item => item.target === use.owner);
        const tokens = document?.tokens ?? parseAnnotationBody(bodyOwner!.body);
        assert.equal(tokens[use.tokenIndex].children![use.childIndex].type, 'link_open');
        assert.equal(resolveTermHref(model, tokens[use.tokenIndex].children![use.childIndex].attrGet('href')!), use.target);
        if (bodyOwner) { assert.deepEqual(use.at, bodyOwner.at); }
    }
    assert.deepEqual(model.uses.slice(0, 2).map(use => use.childIndex), [0, 4]);
    assert.equal(termByTarget(model, model.terms[0].target), model.terms[0]);
    assert.equal(termByTarget(model, 'not-a-target'), undefined);
    assert.equal(parsed.publication.contributions.length, 0);
    assert.ok(parsed.documents.every(document => document.blocks.every(block => block.kind === 'markdown')));
});

test('ASCII key and required JSON title grammar has explicit boundaries', () => {
    for (const header of ['TERM A ""', 'TERM A_.:-09 "Escaped \\"title\\""',
        `TERM ${'A'.repeat(100)} "${'😀'.repeat(200)}"`]) {
        assert.deepEqual(collect(fence(header)).diagnostics, [], header);
    }
    for (const header of ['TERM A', 'TERM A bare', 'TERM 1A "Title"', 'TERM Ä "Title"',
        'TERM A/b "Title"', `TERM ${'A'.repeat(101)} "Title"`,
        `TERM A "${'😀'.repeat(201)}"`, 'TERM A "bad\\q"', 'TERM A "Title" extra', 'NOTE extra']) {
        const result = collect(fence(header));
        assert.equal(result.diagnostics[0]?.code, 'annotation-header', header);
        assert.equal(result.terms.length + result.notes.length, 0, header);
    }
});

test('duplicate keys are ambiguous everywhere and strict generation is atomic', () => {
    const text = '[missing](term:no) [ambiguous](term:A) [case](term:a)\n\n'
        + fence('TERM A "One"', '[self](term:A)') + fence('TERM A "Two"', '[self](term:A)');
    const parsed = parseProject([{ path: 'index.literate', text }]);
    assert.equal(parsed.annotations.diagnostics.filter(d => d.code === 'annotation-duplicate').length, 2);
    assert.equal(parsed.annotations.uses.filter(use => use.resolution === 'ambiguous').length, 3);
    assert.equal(parsed.annotations.uses.filter(use => use.resolution === 'missing').length, 2);
    assert.ok(parsed.annotations.uses.every(use => use.target === undefined));
    assert.notEqual(parsed.annotations.terms[0].target, parsed.annotations.terms[1].target);
    for (const term of parsed.annotations.terms) {
        assert.ok(parsed.annotations.uses.some(use => use.owner === term.target));
    }
    for (const href of ['term:A', 'term:no', 'term:%ZZ', 'term:%2541', 'https://example.org']) {
        assert.equal(resolveTermHref(parsed.annotations, href), undefined);
    }
    const generated = generateProject([{ path: 'index.literate', text }]);
    assert.deepEqual(generated.files, []);
    assert.deepEqual(generated.diagnostics, parsed.diagnostics);
});

test('controlled bodies reject HTML, images, code, Mermaid and nested annotations at any list depth', () => {
    const bodies = ['![alt](image.png)', '<span>HTML</span>', '<!-- comment -->', '<script>alert(1)</script>',
        '    indented code', '# Heading', '> quote', '~~strike~~',
        fence('mermaid', 'graph TD'), fence('TERM inner "Inner"', 'nested'), fence('NOTE', 'nested'),
        '- list\n  - ![alt](image.png)', '- list\n\n  ```js\n  code\n  ```'];
    for (const body of bodies) {
        const text = fence('TERM A "Title"', body, '````');
        const parsed = parseProject([{ path: 'index.literate', text }]);
        assert.equal(parsed.annotations.terms.length, 1, body);
        assert.equal(parsed.annotations.diagnostics[0]?.code, 'annotation-body', body);
        assert.deepEqual(generateProject([{ path: 'index.literate', text }]).files, [], body);
    }
    assert.deepEqual(collect(fence('NOTE', 'Escaped \\<b> and `<b>`\n\n1. **bold**\n2. *italic*')).diagnostics, []);
});

test('target identities, note numbers, CRLF locations and normalized bodies are deterministic', () => {
    const text = 'intro\r\n\r\n  ```TERM A "Title"\r\nbody\r\n  ```\r\n\r\n```NOTE\r\n[A](term:A)\r\n```\r\n';
    const model = collect(text);
    assert.deepEqual(model, collect(text));
    assert.deepEqual(model.terms[0].at, { path: 'index.literate', line: 2, column: 2 });
    assert.equal(model.terms[0].body, 'body\n');
    assert.equal(model.terms[0].target, collect('\n' + text).terms[0].target);
    assert.match(model.terms[0].target, /^annotation-term-[0-9a-f]+$/);
    assert.match(model.notes[0].target, /^annotation-note-[0-9a-f]+-6-0$/);
    const more = collect(fence('NOTE', 'one') + fence('NOTE', 'two'));
    assert.deepEqual(more.notes.map(note => note.number), [1, 2]);
    assert.notEqual(more.notes[0].target, more.notes[1].target);
});

test('annotation text cannot declare fragments and collection never mutates caller tokens', () => {
    const text = fence('TERM A "<<fragment>>="', '<<missing>>') + fence('NOTE', '[bad](term:%ZZ)');
    const tokens = new MarkdownIt().parse(text, {});
    const before = JSON.stringify(tokens);
    const annotations = collectAnnotations([{ path: 'index.literate', text, tokens }]);
    assert.equal(JSON.stringify(tokens), before);
    assert.equal(annotations.uses[0].resolution, 'missing');
    const parsed = parseProject([{ path: 'index.literate', text }]);
    assert.deepEqual(parsed.inspection.fragments, []);
    assert.deepEqual(parsed.publication.contributions, []);
    assert.ok(parsed.diagnostics.every(diagnostic => diagnostic.code?.startsWith('annotation-')));
});
