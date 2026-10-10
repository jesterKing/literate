/* Fixture dictionaries intentionally use filesystem paths as property names. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import { FragmentInspection, GenerationResult, ProjectInspection, generateProject } from '../../engine';

function fence(header: string, body = ''): string {
    return '```' + header + '\n' + body + (body && !body.endsWith('\n') ? '\n' : '') + '```\n';
}

const at = (path: string, line: number, column = 0) => ({ path, line, column });
const ref = (name: string, path: string, line: number, column = 0) => ({ name, ...at(path, line, column) });

test('inspection preserves original repeated inline positions, forward references, and escaped literals', () => {
    const result: GenerationResult = generateProject([{ path: './index.literate', text:
        fence('text: <<main.*>>= ./build/../result.txt $', '<<later>>/<<later>>\nprefix <<lines>> suffix\n\\<<missing>> <<later>>')
        + fence('text: <<later>>=', 'LONGER')
        + fence('text: <<lines>>=', 'A\nB\n\\<<later>>')
    }]);
    const inspection: ProjectInspection = result.inspection;
    const main: FragmentInspection = inspection.fragments[0];
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(inspection.documents, ['index.literate']);
    assert.deepEqual(inspection.templates, []);
    assert.deepEqual(main, {
        name: 'main.*', language: 'text', output: 'result.txt',
        definitions: [at('index.literate', 0)],
        references: [ref('later', 'index.literate', 1), ref('later', 'index.literate', 1, 10),
            ref('lines', 'index.literate', 2, 7), ref('later', 'index.literate', 3, 13)]
    });
    assert.deepEqual(inspection.fragments.slice(1), [
        { name: 'later', language: 'text', definitions: [at('index.literate', 5)], references: [] },
        { name: 'lines', language: 'text', definitions: [at('index.literate', 8)], references: [] }
    ]);
    assert.equal(result.files.find(file => file.path === 'result.txt')?.content,
        'LONGER/LONGER\nprefix A\n B\n <<later>> suffix\n<<missing>> LONGER\n');
});

test('inspection follows index links and keeps every append definition and reference in document order', () => {
    const documents = [
        { path: 'a.literate', text: fence(': <<piece>>=+', 'A <<leaf>>') },
        { path: 'z.literate', text: fence(': <<piece>>=+', 'Z <<leaf>>') },
        { path: './chapter two.literate', text: fence(': <<piece>>=+', 'linked <<leaf>>') },
        { path: './index.literate', text:
            '[chapter](chapter%20two.html#part)\n[again](chapter%20two.literate?x=1)\n'
            + fence('text: <<main.*>>= result.txt $', '<<piece>>')
            + fence(': <<piece>>=', 'index <<leaf>>') + fence(': <<leaf>>=', 'L') }
    ];
    const result = generateProject(documents);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(generateProject([...documents].reverse()), result);
    assert.deepEqual(result.inspection.documents, ['index.literate', 'chapter two.literate', 'a.literate', 'z.literate']);
    assert.deepEqual(result.inspection.fragments.map(fragment => fragment.name), ['main.*', 'piece', 'leaf']);
    assert.deepEqual(result.inspection.fragments[1], {
        name: 'piece', language: '',
        definitions: [at('index.literate', 5), at('chapter two.literate', 0), at('a.literate', 0), at('z.literate', 0)],
        references: [ref('leaf', 'index.literate', 6, 6), ref('leaf', 'chapter two.literate', 1, 7),
            ref('leaf', 'a.literate', 1, 2), ref('leaf', 'z.literate', 1, 2)]
    });
    assert.equal(result.files[0].content, 'index L\nlinked L\nA L\nZ L\n');
});

test('inspection lists sorted normalized referenced templates, including missing contents', () => {
    const documents = [{ path: 'index.literate', text:
        fence('SETTINGS', 'template=./templates/../z.page')
        + fence('text: <<main.*>>= ./out/../result.txt $ template=./a.source', 'value')
        + fence('text: <<other.*>>= other.txt $ template=templates/../a.source', 'other')
    }, { path: 'chapter.literate', text: fence('SETTINGS', 'template=ignored.page') }];
    const missing = generateProject(documents, { 'unused.template': 'unused' });
    assert.deepEqual(missing.files, []);
    assert.deepEqual(missing.inspection.templates, ['a.source', 'z.page']);
    assert.deepEqual(missing.inspection.fragments[0], {
        name: 'main.*', language: 'text', output: 'result.txt', template: 'a.source',
        definitions: [at('index.literate', 3)], references: []
    });
    assert.deepEqual(missing.diagnostics.map(diagnostic => diagnostic.message), [
        'Missing template: z.page', 'Missing template: a.source', 'Missing template: a.source'
    ]);
    const valid = generateProject(documents, { './z.page': '[CONTENT]', 'a.source': 'before [CODE]after' });
    assert.deepEqual(valid.diagnostics, []);
    assert.deepEqual(valid.inspection, missing.inspection);
    assert.equal(valid.files[0].content, 'before value\nafter');
});

test('nested fences retain exact original columns and expansion diagnostics share reference positions', () => {
    const text = [
        '> - ```text: <<nested.*>>= nested.txt $',
        '>   \t😀 <<absent>>/<<absent>> \\<<escaped>>',
        '>   ```',
        '',
        '  ~~~text: <<nested.*>>=+',
        '  \t<<absent>>=+',
        '  ~~~'
    ].join('\r\n');
    const result = generateProject([{ path: 'index.literate', text }]);
    const references = [ref('absent', 'index.literate', 1, 8), ref('absent', 'index.literate', 1, 19),
        ref('absent', 'index.literate', 5, 3)];
    assert.deepEqual(result.inspection.fragments, [{
        name: 'nested.*', language: 'text', output: 'nested.txt',
        definitions: [at('index.literate', 0, 4), at('index.literate', 4, 2)], references
    }]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, [
        { ...at('index.literate', 1, 8), message: 'Missing fragment: absent', code: 'missing-fragment' },
        { ...at('index.literate', 1, 19), message: 'Missing fragment: absent', code: 'missing-fragment' },
        { ...at('index.literate', 5, 3), message: 'Invalid definition operator on reference: absent' },
        { ...at('index.literate', 5, 3), message: 'Missing fragment: absent', code: 'missing-fragment' }
    ]);
});

test('partially consumed tabs map references to source columns rather than visual indentation', () => {
    const result = generateProject([{ path: 'index.literate', text:
        '- ```text: <<main.*>>= result.txt $\n\t<<missing>>\n  ```\n'
    }]);
    assert.deepEqual(result.inspection.fragments[0].definitions, [at('index.literate', 0, 2)]);
    assert.deepEqual(result.inspection.fragments[0].references, [ref('missing', 'index.literate', 1, 1)]);
    assert.deepEqual(result.diagnostics, [{
            ...at('index.literate', 1, 1), message: 'Missing fragment: missing', code: 'missing-fragment'
        }]);
    assert.deepEqual(result.files, []);
});

test('diagnostics preserve accepted parser metadata without inventing rejected definitions', () => {
    const result = generateProject([
        { path: '../invalid.literate', text: fence(': <<invalid>>=', 'bad') },
        { path: 'with-nul.literate', text: '\u0000' },
        { path: 'index.literate', text:
            fence(': <<kept>>=', '<<cycle>>')
            + fence(': <<kept>>=', '<<rejected>>')
            + fence(': <<orphan>>=+', '<<rejected>>')
            + fence('text: <<malformed>>', 'bad')
            + fence(': <<cycle>>=', '<<kept>>')
            + fence(': <<kept>>=+', '<<missing>>') },
        { path: './index.literate', text: fence(': <<duplicate document>>=', 'bad') }
    ]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.inspection, {
        documents: ['index.literate'], templates: [], fragments: [
            { name: 'kept', language: '', definitions: [at('index.literate', 0), at('index.literate', 15)],
                references: [ref('cycle', 'index.literate', 1), ref('missing', 'index.literate', 16)] },
            { name: 'cycle', language: '', definitions: [at('index.literate', 12)],
                references: [ref('kept', 'index.literate', 13)] }
        ]
    });
    for (const message of ['Invalid source path', 'NUL', 'Duplicate source document', 'Duplicate fragment',
        'Cannot append', 'Invalid fragment header', 'Fragment cycle', 'Missing fragment']) {
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes(message)), message);
    }
});

test('ordinary fences are not fragments and empty projects still provide inspection', () => {
    assert.deepEqual(generateProject([]), {
        files: [], diagnostics: [], inspection: { documents: [], templates: [], fragments: [] },
                publication: { documents: [], fragments: [], contributions: [], proseReferences: [] }
    });
    const result = generateProject([{ path: 'only.literate', text: fence('text', '<<not a reference>>') }]);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.inspection, { documents: ['only.literate'], templates: [], fragments: [] });
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].content, /&lt;&lt;not a reference&gt;&gt;/);
});
