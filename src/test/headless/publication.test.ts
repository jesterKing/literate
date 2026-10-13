import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import { generateProject, PublicationContribution, PublicationSegment } from '../../engine';

function fence(header: string, body = ''): string {
    return '```' + header + '\n' + body + (body && !body.endsWith('\n') ? '\n' : '') + '```\n';
}

function references(contribution: PublicationContribution) {
    return contribution.segments.filter((segment): segment is Extract<PublicationSegment, { kind: 'reference' }> =>
        segment.kind === 'reference');
}

const project = (text: string) => generateProject([{ path: 'index.literate', text }]);

test('publication orders documents and interleaved contributions, retaining each append language', () => {
    const documents = [
        { path: 'a.literate', text: fence('js: <<piece>>=+', 'A') },
        { path: 'z.literate', text: fence('python: <<piece>>=+', 'Z') },
        { path: './index.literate', text: '[Z](z.html)\n\n'
            + fence('text: <<main.*>>= result.txt $', '<<piece>>')
            + fence('ts: <<piece>>=', 'first <<leaf>>')
            + fence('text: <<leaf>>=', 'L')
            + fence('json: <<piece>>=+', 'last') }
    ];
    const result = generateProject(documents);
    const model = result.publication;
    assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.severity !== 'warning'), []);
    assert.deepEqual(model.documents.map(document => document.path), ['index.literate', 'z.literate', 'a.literate']);
    assert.deepEqual(model.fragments.map(fragment => fragment.name), ['main.*', 'piece', 'leaf']);
    assert.deepEqual(model.contributions.map(part => part.language), ['text', 'ts', 'text', 'json', 'python', 'js']);
    assert.deepEqual(model.contributions.map(part => part.kind), ['definition', 'definition', 'definition', 'append', 'append', 'append']);
    assert.deepEqual(model.fragments[1].contributions, [1, 3, 4, 5].map(index => model.contributions[index].target));
    assert.deepEqual(model.documents.flatMap(document => document.contributions), model.contributions.map(part => part.target));
    for (const part of model.contributions) {
        const source = documents.find(document => document.path.replace(/^\.\//, '') === part.definition.path)!;
        const token = new MarkdownIt().parse(source.text, {})[part.tokenIndex];
        assert.equal(token.type, 'fence');
        assert.equal(token.content, part.content);
    }
    assert.deepEqual(generateProject([...documents].reverse()), result);
    assert.equal(result.files.find(file => file.path === 'result.txt')?.content, 'first L\nlast\nZ\nA\n');
});

test('publication resolves forward and repeated occurrences without expanding or unescaping content', () => {
    const body = '😀 <<later>>/<<later>>\n\\<<literal>> and <<later>>';
    const result = project(fence('text: <<main.*>>= result.txt $', body) + fence(': <<later>>=', 'value'));
    const main = result.publication.contributions[0];
    assert.deepEqual(result.diagnostics, []);
    assert.equal(main.content, body + '\n');
    assert.equal(main.segments.map(segment => segment.text).join(''), main.content);
    assert.equal(references(main).length, 3);
    assert.equal(references(main)[0].start, 3, 'offsets count UTF-16 code units, not code points');
    assert.equal(references(main)[0].at.column, 3);
    for (const reference of references(main)) {
        assert.equal(main.content.slice(reference.start, reference.end), '<<later>>');
        assert.deepEqual(reference.resolution, { kind: 'resolved', target: result.publication.fragments[1].target });
    }
    assert.ok(main.segments.some(segment => segment.kind === 'text' && segment.text.includes('\\<<literal>>')));
});

test('publication retains accepted state on diagnostics without inventing rejected contributions', () => {
    const result = generateProject([
        { path: '../invalid.literate', text: fence(': <<invalid>>=', 'bad') },
        { path: 'nul.literate', text: '\0' },
        { path: 'index.literate', text:
            fence(': <<kept>>=', '<<cycle>>') + fence(': <<kept>>=', '<<rejected>>')
            + fence(': <<orphan>>=+', '<<rejected>>') + fence('text: <<malformed>>', 'bad')
            + fence(': <<cycle>>=', '<<kept>>') + fence(': <<kept>>=+', '<<missing>>=+') },
        { path: './index.literate', text: fence(': <<duplicate document>>=', 'bad') }
    ]);
    const model = result.publication;
    assert.deepEqual(result.files, []);
    assert.deepEqual(model.documents.map(document => document.path), ['index.literate']);
    assert.deepEqual(model.fragments.map(fragment => fragment.name), ['kept', 'cycle']);
    assert.equal(model.contributions.length, 3);
    const missing = references(model.contributions[2])[0];
    assert.deepEqual(missing.resolution, { kind: 'missing' });
    assert.equal(missing.modifier, '=+');
    assert.equal(missing.text, '<<missing>>=+');
    assert.equal(missing.end - missing.start, '<<missing>>'.length);
    assert.deepEqual(references(model.contributions[0])[0].resolution, { kind: 'resolved', target: model.fragments[1].target });
    for (const part of model.contributions) {
        assert.equal(part.segments.map(segment => segment.text).join(''), part.content);
    }
});

test('diagnosed output settings do not erase graph-retained definitions and appends', () => {
    const result = project(fence(': <<piece>>= forbidden.txt $', 'base')
        + fence('js: <<piece>>=+ forbidden.txt $', 'append') + fence(': <<empty>>='));
    assert.deepEqual(result.files, []);
    assert.equal(result.diagnostics.length, 2);
    assert.equal(result.publication.contributions.length, 3);
    assert.equal(result.publication.contributions[1].kind, 'append');
    assert.equal(result.publication.contributions[2].content, '');
    assert.deepEqual(result.publication.contributions[2].segments, []);
});

test('publication maps container/tab coordinates while preserving Markdown-normalized code', () => {
    const text = ['> - ```text: <<nested.*>>= nested.txt $',
        '>   \t😀 <<absent>>/<<absent>> \\<<escaped>>', '>   ```', '',
        '  ~~~text: <<nested.*>>=+', '  \t<<absent>>=+', '  ~~~'].join('\r\n');
    const result = project(text);
    const parts = result.publication.contributions;
    assert.deepEqual(parts.map(part => part.definition), [
        { path: 'index.literate', line: 0, column: 4 }, { path: 'index.literate', line: 4, column: 2 }
    ]);
    assert.deepEqual(parts.flatMap(part => references(part).map(reference => reference.at)), [
        { path: 'index.literate', line: 1, column: 8 }, { path: 'index.literate', line: 1, column: 19 },
        { path: 'index.literate', line: 5, column: 3 }
    ]);
    for (const part of parts) {
        assert.equal(part.segments.map(segment => segment.text).join(''), part.content);
        assert.ok(!part.content.includes('\r'));
    }
    const tabs = project('- ```text: <<main.*>>= result.txt $\n\t<<missing>>\n  ```\n');
    assert.equal(references(tabs.publication.contributions[0])[0].at.column, 1);
});

test('target encoding distinguishes punctuation, case, Unicode and namespace-like names', () => {
    const names = ['a/b', 'a-b', 'a_b', 'A-b', 'é', 'e\u0301', '😀', 'f-0061', 'a', 'a-b-c', '漢字'];
    const model = project(names.map(name => fence(': <<' + name + '>>=', name)).join('')).publication;
    const targets = [...model.fragments.map(fragment => fragment.target), ...model.contributions.map(part => part.target)];
    assert.equal(new Set(targets).size, targets.length);
    for (const target of targets) { assert.match(target, /^[fc]-[0-9a-f-]+$/); }
    assert.equal(model.fragments.find(fragment => fragment.name === 'a')?.target, 'f-0061');
});

test('targets survive prose shifts and unrelated contributions; same-family insertions renumber locally', () => {
    const base = fence(': <<piece>>=', 'base');
    const append = fence(': <<piece>>=+', 'append');
    const before = project(base + append).publication;
    const shifted = project('# Prose\n\n' + base + fence(': <<other>>=', 'other') + append).publication;
    assert.deepEqual(shifted.fragments.find(fragment => fragment.name === 'piece'), before.fragments[0]);
    assert.deepEqual(shifted.contributions.filter(part => part.fragmentTarget === before.fragments[0].target)
        .map(part => part.target), before.contributions.map(part => part.target));
    const inserted = project(base + fence(': <<piece>>=+', 'new') + append).publication;
    assert.notEqual(inserted.contributions[2].target, before.contributions[1].target);
    const moved = generateProject([{ path: 'moved.literate', text: base + append }]).publication;
    assert.equal(moved.fragments[0].target, before.fragments[0].target);
    assert.notEqual(moved.contributions[0].target, before.contributions[0].target);
});

test('modified adjacent references retain tag boundaries and every trailing operator byte', () => {
    for (const modifier of ['=', '+', '=+']) {
        const body = '<<leaf>>' + modifier + '<<leaf>>' + modifier + '=tail';
        const result = project(fence(': <<main>>=', body) + fence(': <<leaf>>=', 'value'));
        const part = result.publication.contributions[0];
        assert.equal(part.segments.map(segment => segment.text).join(''), body + '\n');
        assert.equal(references(part).length, 2);
        for (const reference of references(part)) {
            assert.equal(reference.modifier, modifier);
            assert.equal(reference.text, '<<leaf>>' + modifier);
            assert.equal(part.content.slice(reference.start, reference.end), '<<leaf>>');
        }
        assert.deepEqual(result.files, []);
    }
});

test('rejected declarations do not consume ordinals and ordinal changes stay document-local', () => {
    const base = fence(': <<piece>>=', 'base');
    const append = fence(': <<piece>>=+', 'append');
    const chapter = { path: 'chapter.literate', text: append };
    const before = generateProject([{ path: 'index.literate', text: base + append }, chapter]).publication;
    const rejected = generateProject([{ path: 'index.literate', text:
        fence(': <<orphan>>=+', 'orphan') + base + fence(': <<piece>>=', 'duplicate') + append }, chapter]).publication;
    assert.deepEqual(rejected.contributions.map(part => part.target), before.contributions.map(part => part.target));
    const inserted = generateProject([{ path: 'index.literate', text: base + append + append }, chapter]).publication;
    assert.equal(inserted.contributions[3].target, before.contributions[2].target);
});

test('ordinary and SETTINGS fences remain outside publication contributions', () => {
    const result = project(fence('SETTINGS', 'theme=rosepine-dawn') + fence('text', '<<not a reference>>'));
    assert.deepEqual(result.publication, {
        documents: [{ path: 'index.literate', contributions: [] }], fragments: [], contributions: [],
        proseReferences: []
    });
    assert.deepEqual(result.diagnostics, []);
});
