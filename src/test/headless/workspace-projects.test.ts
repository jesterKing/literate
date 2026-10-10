import assert = require('node:assert/strict');
import { test } from 'node:test';
import { parsePublicationWorkspace, publicationForPath, selectPublication } from '../../workspace-projects';

const manifest = (publications: unknown[]) => JSON.stringify({ schemaVersion: 1, publications });
const project = (id: string, root = id) => ({ id, title: `Book ${id}`, root,
    entry: 'index.literate', pdf: `publications/${id}.pdf` });

test('workspace manifests retain ordered normalized publication metadata', () => {
    const parsed = parsePublicationWorkspace(manifest([
        project('python', 'books/./python'),
        { id: 'zig', root: 'books/zig' }
    ]));
    assert.deepEqual(parsed, { schemaVersion: 1, publications: [
        project('python', 'books/python'),
        { id: 'zig', title: 'zig', root: 'books/zig', entry: 'index.literate' }
    ] });
    assert.equal(selectPublication(parsed, 'zig').root, 'books/zig');
    assert.equal(publicationForPath(parsed, 'books/python/chapter.literate')?.id, 'python');
    assert.equal(publicationForPath(parsed, 'books/zig')?.id, 'zig');
    assert.equal(publicationForPath(parsed, 'outside/index.literate'), undefined);
});

test('one publication is implicit while a series requires an exact selector', () => {
    const single = parsePublicationWorkspace(manifest([project('only')]));
    assert.equal(selectPublication(single).id, 'only');
    const series = parsePublicationWorkspace(manifest([project('one'), project('two')]));
    assert.throws(() => selectPublication(series), /Select a publication: one, two/);
    assert.throws(() => selectPublication(series, 'One'), /Unknown publication One/);
});

for (const [name, source, message] of [
    ['invalid JSON', '{', /Invalid workspace manifest JSON/],
    ['non-object root', '[]', /must be an object/],
    ['unknown root field', JSON.stringify({ schemaVersion: 1, publications: [], extra: true }), /unknown field: extra/],
    ['wrong schema', JSON.stringify({ schemaVersion: 2, publications: [] }), /schemaVersion must be 1/],
    ['empty publications', manifest([]), /1 to 1000 entries/],
    ['unknown publication field', manifest([{ ...project('one'), extra: true }]), /unknown field: extra/],
    ['invalid id', manifest([project('Bad ID')]), /id is invalid/],
    ['unsafe root', manifest([project('one', '../one')]), /not a safe relative path/],
    ['invalid entry', manifest([{ ...project('one'), entry: 'README.md' }]), /entry must end in .literate/],
    ['invalid PDF', manifest([{ ...project('one'), pdf: 'book.tex' }]), /pdf must end in .pdf/],
    ['duplicate id', manifest([project('one'), project('one', 'two')]), /id conflicts/],
    ['duplicate root', manifest([project('one', 'books/a'), project('two', 'BOOKS/A')]), /root overlaps/],
    ['nested root', manifest([project('one', 'books'), project('two', 'books/two')]), /root overlaps/],
    ['duplicate PDF', manifest([project('one'), { ...project('two'), pdf: 'PUBLICATIONS/one.pdf' }]), /PDF conflicts/]
] as const) {
    test(`workspace manifest rejects ${name}`, () => assert.throws(() => parsePublicationWorkspace(source), message));
}

test('workspace manifests bound source and publication counts', () => {
    assert.throws(() => parsePublicationWorkspace(' '.repeat(1024 * 1024 + 1)), /exceeds 1 MiB/);
    assert.throws(() => parsePublicationWorkspace(manifest(Array.from({ length: 1001 }, (_, index) =>
        project(`book-${index}`)))), /1 to 1000 entries/);
});
