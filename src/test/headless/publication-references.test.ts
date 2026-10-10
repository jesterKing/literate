import assert = require('node:assert/strict');
import { test } from 'node:test';
import { parseProject } from '../../engine';
import { parsePublicationReference, publicationDefinitions, resolvePublicationReference }
    from '../../publication-references';

const project = parseProject([{ path: 'index.literate', text: [
    '```TERM pivot "Pivot"', 'A partition value.', '```', '',
    '```python : <<partition values>>=', 'pass', '```', '',
    '```mermaid id=partition-flow', 'flowchart TD', '```', ''
].join('\n') }]);

test('semantic publication references parse exact namespaced identifiers', () => {
    assert.deepEqual(parsePublicationReference('term/pivot'), { kind: 'term', id: 'pivot' });
    assert.deepEqual(parsePublicationReference('fragment/partition%20values'),
        { kind: 'fragment', id: 'partition values' });
    assert.deepEqual(parsePublicationReference('diagram/partition-flow'),
        { kind: 'diagram', id: 'partition-flow' });
    for (const value of ['', 'heading/title', 'term/', 'term/%zz', 'term/two%20words',
        'fragment/%00bad']) {
        assert.equal(parsePublicationReference(value), undefined, value);
    }
});

test('semantic publication references resolve terms and fragment families', () => {
    const definitions = publicationDefinitions(project);
    assert.deepEqual(definitions.map(item => [item.kind, item.id]), [
        ['term', 'pivot'], ['diagram', 'partition-flow'], ['fragment', 'partition values']
    ]);
    const term = resolvePublicationReference(project, { kind: 'term', id: 'pivot' });
    const fragment = resolvePublicationReference(project, { kind: 'fragment', id: 'partition values' });
    const diagram = resolvePublicationReference(project, { kind: 'diagram', id: 'partition-flow' });
    assert.equal(term.status, 'resolved');
    assert.equal(fragment.status, 'resolved');
    assert.equal(diagram.status, 'resolved');
    if (diagram.status === 'resolved') { assert.match(diagram.value.target, /^diagram-/); }
    assert.equal(resolvePublicationReference(project, { kind: 'diagram', id: 'missing' }).status, 'missing');
});
