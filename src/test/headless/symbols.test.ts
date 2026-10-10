import assert = require('node:assert/strict');
import { test } from 'node:test';
import { generateProject, parseFragmentHeader, scanFragmentTags, SourceDocument } from '../../engine';
import { collectFragmentOccurrences, planFragmentRename } from '../../symbols';

function fence(header: string, body = ''): string {
    return '```' + header + '\n' + body + '\n```\n';
}

function checkRanges(documents: SourceDocument[]): void {
    for (const item of collectFragmentOccurrences(documents)) {
        const document = documents.find(document => document.path.replace(/^\.\//, '') === item.path)!;
        const line = document.text.split(/\r\n|\r|\n/)[item.line];
        assert.equal(line.slice(item.column, item.endColumn), `<<${item.name}>>`);
    }
}

test('shared scanner preserves tag-only ranges and exact rail annotations', () => {
    const text = '😀 <<a>>=+ <<a>>[rail]+ \\<<a>>[rail] <<a b>>[Rail] <<"$&$`\'">>[rail]';
    const tags = scanFragmentTags(text);
    assert.deepEqual(tags.map(tag => [tag.name, tag.annotation, tag.modifier]), [
        ['a', undefined, '=+'], ['a', 'rail', '+'], ['a b', undefined, undefined],
        ['"$&$`\'"', 'rail', undefined]
    ]);
    for (const tag of tags) { assert.equal(text.slice(tag.start, tag.end), `<<${tag.name}>>`); }
    assert.deepEqual(scanFragmentTags('<<>> <<bad\nname>> \\<<skip>>[rail]'), []);
});

test('shared header grammar anchors the tag rather than a repeated substring', () => {
    const info = ' name: <<name>>=+ name <<other>>= $ ';
    const header = parseFragmentHeader(info)!;
    assert.equal(header.name, 'name');
    assert.equal(header.language, 'name');
    assert.equal(header.append, true);
    assert.equal(header.remainder, 'name <<other>>= $');
    assert.equal(info.slice(header.tagStart, header.tagEnd), '<<name>>');
    for (const bad of ['ts <<name>>=', ': <<>>=', ': <<   >>=', ': <<name>>', ': <<a<b>>=']) {
        assert.equal(parseFragmentHeader(bad), undefined, bad);
    }
});

test('nested fences, tabs, CRLF, repeated references and UTF-16 agree with engine inspection', () => {
    const text = [
        '> - ```text: <<nested.*>>= nested.txt $',
        '>   \t😀 <<absent>>/<<absent>> \\<<escaped>>', '>   ```', '',
        '  ~~~text: <<nested.*>>=+', '  \t<<absent>>=+', '  ~~~', '',
        '- ```text: <<piece>>=', '\t<<absent>>', '  ```'
    ].join('\r\n');
    const documents = [{ path: 'index.literate', text }];
    const occurrences = collectFragmentOccurrences(documents);
    const references = occurrences.filter(item => item.kind === 'reference')
        .map(({ name, path, line, column }) => ({ name, path, line, column }));
    assert.deepEqual(references, generateProject(documents).inspection.fragments.flatMap(fragment => fragment.references));
    assert.deepEqual(occurrences.filter(item => item.kind !== 'reference').map(item => item.column), [13, 11, 11]);
    checkRanges(documents);
});

test('prose headings, labels, inline code and repeats are mentions but unrelated syntax is not', () => {
    const documents = [{ path: './chapter.literate', text: [
        '# <<a>>/<<a>> ###', '',
        '> - 😀 <<a>> and `<<a>>` and ``x ` <<a>>``',
        '>   \\<<escaped>> `\\<<escaped>>` \\\\<<escaped>> bare a &lt;&lt;entity&gt;&gt;', '',
        '[<<label>>](target/<<destination>> "<<title>>") and <<a>>', '',
        '[id]: target/<<reference-destination>>', '',
        'before ![<<alt>> `<<code alt>>`](target/<<image-destination>>) after', '',
        'paragraph before HTML', '<div>', '<<html>>', '</div>', '',
        '    <<indented>>', '',
        fence('text', '<<example>>'), fence('SETTINGS', '<<setting>>'),
        fence('ts <<malformed>>=', '<<ignored>>'),
        fence('text: <<a>>= file<<filename>> $ template=<<template>>', '<<missing>>')
    ].join('\n') }];
    const occurrences = collectFragmentOccurrences(documents);
    assert.deepEqual(occurrences.map(item => [item.name, item.kind]), [
        ['a', 'mention'], ['a', 'mention'], ['a', 'mention'], ['a', 'mention'], ['a', 'mention'],
        ['label', 'mention'], ['a', 'mention'], ['a', 'definition'], ['missing', 'reference']
    ]);
    checkRanges(documents);
});

test('rename uses caller text across documents and changes only exact name ranges', () => {
    const oldName = 'a', newName = '"$&$$\' quoted"';
    const documents = [
        { path: './one.literate', text: fence('a: <<a>>=', '\\<<a>> <<a>>/<<a>> <<a long>>') + '<<a>> `<<a>>` a\n' },
        { path: 'folder/../two.literate', text: fence(': <<a>>=+', '<<a>>') + fence(': <<a long>>=', 'literal') }
    ];
    const edits = planFragmentRename(documents, oldName, newName);
    assert.equal(edits.length, 7);
    assert.ok(edits.every(edit => edit.newText === newName));
    const changed = documents.map((document, index) => {
        const path = index ? 'two.literate' : 'one.literate';
        const lines = document.text.split('\n');
        for (const edit of edits.filter(edit => edit.path === path).reverse()) {
            assert.equal(lines[edit.line].slice(edit.startColumn, edit.endColumn), oldName);
            lines[edit.line] = lines[edit.line].slice(0, edit.startColumn) + edit.newText + lines[edit.line].slice(edit.endColumn);
        }
        return { path, text: lines.join('\n') };
    });
    assert.equal(collectFragmentOccurrences(changed).filter(item => item.name === newName).length, edits.length);
    assert.ok(changed[0].text.includes('\\<<a>>'));
    assert.ok(changed[0].text.includes('<<a long>>'));
    assert.ok(changed[0].text.endsWith(' a\n'));
    assert.deepEqual(planFragmentRename(changed, newName, newName), []);
});

test('rename rejects invalid names, absent or duplicate bases and root changes, including no-ops', () => {
    const documents = [{ path: 'a.literate', text: fence(': <<a>>=', '') }];
    for (const name of ['', ' ', '.*', ' a', 'a ', 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\x7fb', '<a', 'a>', 'a\u2028b']) {
        assert.throws(() => planFragmentRename(documents, 'a', name), /Invalid new fragment name/);
        assert.throws(() => planFragmentRename(documents, name, name), /Invalid old fragment name/);
    }
    assert.throws(() => planFragmentRename([], 'a', 'b'), /exactly one base definition.*found 0/);
    assert.throws(() => planFragmentRename(documents, 'missing', 'missing'), /found 0/);
    assert.throws(() => planFragmentRename([{ path: 'a.literate', text: fence(': <<a>>=+', '') }], 'a', 'b'), /found 0/);
    assert.throws(() => planFragmentRename([{ path: 'a.literate', text: documents[0].text.repeat(2) }], 'a', 'a'), /found 2/);
    assert.throws(() => planFragmentRename(documents, 'a', 'b.*'), /preserve the root suffix/);
    const roots = [{ path: 'a.literate', text: fence(': <<a.*>>= a.txt $', '') }];
    assert.throws(() => planFragmentRename(roots, 'a.*', 'b'), /preserve the root suffix/);
    assert.equal(planFragmentRename(roots, 'a.*', 'b.*')[0].newText, 'b.*');
});

test('rename rejects definitions, orphan appends, missing references and prose collisions', () => {
    for (const collision of [fence(': <<b>>='), fence(': <<b>>=+'), fence(': <<c>>=', '<<b>>'), '<<b>>']) {
        const documents = [{ path: 'a.literate', text: fence(': <<a>>=') + collision }];
        assert.throws(() => planFragmentRename(documents, 'a', 'b'), /collision/);
    }
});

test('safe path normalization and duplicate checks apply even to no-op plans', () => {
    const document = { path: 'dir/../a.literate', text: fence(': <<a>>=') };
    assert.equal(collectFragmentOccurrences([document])[0].path, 'a.literate');
    for (const path of ['../a.literate', '/a.literate', '', 'a\\b.literate', 'CON.literate']) {
        assert.throws(() => collectFragmentOccurrences([{ ...document, path }]), /Invalid source path/);
    }
    for (const path of ['./a.literate', 'A.literate']) {
        assert.throws(() => planFragmentRename([document, { ...document, path }], 'a', 'a'), /Duplicate source document/);
    }
    assert.throws(() => collectFragmentOccurrences([{ ...document, text: '\0' }]), /NUL/);
});

test('named fences still follow default engine parsing inside HTML-looking blocks', () => {
    const documents = [{ path: 'index.literate', text: '<div>\n' + fence(': <<a>>=', '<<missing>>') + '</div>\n' }];
    assert.deepEqual(collectFragmentOccurrences(documents).map(item => [item.name, item.kind]), [
        ['a', 'definition'], ['missing', 'reference']
    ]);
    checkRanges(documents);
});

test('literal dollar replacement strings are safe names in fences', () => {
    const documents = [{ path: 'a.literate', text: fence(': <<a>>=', '<<a>>') }];
    const name = '$&$$\'"';
    const edits = planFragmentRename(documents, 'a', name);
    assert.equal(edits.length, 2);
    assert.ok(edits.every(edit => edit.newText === name));
    const renamed = [{ path: 'a.literate', text: fence(': <<' + name + '>>=', '<<' + name + '>>') }];
    assert.equal(collectFragmentOccurrences(renamed).length, 2);
    checkRanges(renamed);
});

test('rename rejects new backticks but permits existing tilde-fenced names and validated no-ops', () => {
    const documents = [{ path: 'a.literate', text:
        fence(': <<root.*>>= result.txt $', '<<a>>') + fence(': <<a>>=', 'literal')
    }];
    assert.deepEqual(generateProject(documents).diagnostics, []);
    for (const name of ['a`b', '$&$`$\'"']) {
        assert.throws(() => planFragmentRename(documents, 'a', name), /Invalid new fragment name.*backticks/);
    }
    assert.throws(() => planFragmentRename(documents, 'root.*', 'root`.*'), /backticks/);
    const existing = [{ path: 'a.literate', text: '~~~: <<a`b>>=\n<<a`b>>\n~~~\n' }];
    assert.equal(collectFragmentOccurrences(existing).length, 2);
    checkRanges(existing);
    assert.deepEqual(planFragmentRename(existing, 'a`b', 'a`b'), []);
    const edits = planFragmentRename(existing, 'a`b', 'safe');
    assert.equal(edits.length, 2);
    assert.ok(edits.every(edit => edit.newText === 'safe'));
    // Conservative policy applies even when the definition itself uses tildes.
    assert.throws(() => planFragmentRename(existing, 'a`b', 'c`d'), /backticks/);
    assert.throws(() => planFragmentRename([], 'a`b', 'a`b'), /found 0/);
    assert.throws(() => planFragmentRename([{ ...existing[0], text: existing[0].text.repeat(2) }],
        'a`b', 'a`b'), /found 2/);
});

test('table mentions retain raw UTF-16 columns through repeated cells, pipes and containers', () => {
    const rows = [
        '| 😀 <<a>> | <<a>> |', '| --- | --- |',
        '| x\\|y <<a>>/<<a>> | `<<a>>` |',
        '| [<<label>>](target/<<destination>> "<<title>>") | ![<<alt>> `<<code alt>>`](image/<<image-destination>>) <<a>> |',
        '| \\<<escaped>> `\\<<escaped-code>>` \\\\<<escaped-double>> | &lt;&lt;entity&gt;&gt; bare a |',
        '| <<a>> | <<a>> | <<extra>> |',
        '| <<a>> |',
        '| | <<a>> |',
        '| \\\\|😀 <<a>> | <<a\\|b>> |'
    ];
    for (const newline of ['\n', '\r\n', '\r']) {
        for (const container of ['', '> ', '> - ']) {
            const text = rows.map((row, index) =>
                (container === '> - ' && index > 0 ? '>   ' : container) + row).join(newline);
            const documents = [{ path: 'table.literate', text }];
            const occurrences = collectFragmentOccurrences(documents);
            assert.deepEqual(occurrences.map(item => item.name), [
                'a', 'a', 'a', 'a', 'a', 'label', 'a', 'a', 'a', 'a', 'a', 'a', 'a\\|b'
            ]);
            assert.ok(occurrences.every(item => item.kind === 'mention'));
            assert.equal(new Set(occurrences.map(item => `${item.line}:${item.column}`)).size, occurrences.length);
            const lines = text.split(/\r\n|\r|\n/);
            assert.deepEqual(occurrences.filter(item => item.line === 0).map(item => item.column),
                [lines[0].indexOf('<<a>>'), lines[0].lastIndexOf('<<a>>')]);
            checkRanges(documents);
        }
    }
});

test('table mentions participate in rename and collision checks without editing excluded syntax', () => {
    const table = [
        '<<a>> | <<a>>', '--- | ---',
        '😀 x\\|y <<a>> | [<<a>>](target/<<destination>>) `<<a>>`',
        '\\<<escaped>> | ![<<alt>>](image/<<image-destination>>) <<a>>'
    ];
    const documents = [{ path: 'a.literate', text: fence(': <<a>>=', 'body') + '\n' + table.join('\r\n') }];
    const edits = planFragmentRename(documents, 'a', 'renamed');
    assert.equal(edits.length, 7);
    const lines = documents[0].text.split(/\r\n|\r|\n/);
    for (const edit of [...edits].reverse()) {
        assert.equal(lines[edit.line].slice(edit.startColumn, edit.endColumn), 'a');
        lines[edit.line] = lines[edit.line].slice(0, edit.startColumn) + edit.newText + lines[edit.line].slice(edit.endColumn);
    }
    const changed = [{ path: 'a.literate', text: lines.join('\r\n') }];
    assert.equal(collectFragmentOccurrences(changed).filter(item => item.name === 'renamed').length, 7);
    assert.ok(changed[0].text.includes('target/<<destination>>'));
    assert.ok(changed[0].text.includes('\\<<escaped>>'));
    assert.ok(changed[0].text.includes('![<<alt>>](image/<<image-destination>>)'));
    checkRanges(changed);
    for (const row of ['| <<b>> | other |\n| --- | --- |', '| header | other |\n| --- | --- |\n| x\\|y `<<b>>` | |']) {
        assert.throws(() => planFragmentRename([{ path: 'a.literate', text: fence(': <<a>>=') + '\n' + row }],
            'a', 'b'), /collision/);
    }
    for (const name of ['destination', 'escaped', 'alt', 'image-destination']) {
        assert.equal(planFragmentRename(documents, 'a', name).length, 7);
    }
});

test('rename rejects table separators that change the occurrence sequence', () => {
    for (const table of [
        '| heading | other |\n| --- | --- |\n| <<a>> | <<keep>> |',
        '| heading | other |\n| --- | --- |\n| `<<a>>` | <<keep>> |',
        '| <<a>> | other |\n| --- | --- |\n| <<keep>> | text | <<previously ignored>> |'
    ]) {
        const documents = [{ path: './a.literate', text: fence(': <<a>>=') + '\n' + table }];
        const original = documents.map(document => ({ ...document }));
        assert.throws(() => planFragmentRename(documents, 'a', 'x|y'),
            /Unsafe fragment rename: Markdown syntax changes.*occurrence sequence/);
        assert.deepEqual(documents, original);
    }
});

test('rename safety permits context-safe punctuation and shifting columns without mutating documents', () => {
    const documents = [
        { path: './a.literate', text: fence(': <<a>>=', '<<a>>/<<keep>>/<<a>>') },
        { path: 'folder/../table.literate', text:
            '| heading | other |\r\n| --- | --- |\r| 😀 <<a>>/<<keep>>/<<a>> | `<<a>>` |\n' }
    ];
    const original = documents.map(document => ({ ...document }));
    for (const name of ['x\\|y', '[long name] $&', 'z']) {
        const edits = planFragmentRename(documents, 'a', name);
        assert.equal(edits.length, 6);
        assert.deepEqual(edits.map(edit => edit.path), [
            'a.literate', 'a.literate', 'a.literate', 'table.literate', 'table.literate', 'table.literate'
        ]);
        assert.ok(edits.every(edit => edit.newText === name));
        assert.deepEqual(documents, original);
    }
    // A raw pipe is safe in named fences, but not in a table cell.
    assert.equal(planFragmentRename([documents[0]], 'a', 'x|y').length, 3);
});

test('shared scanner keeps generation literal output and escaping unchanged', () => {
    const documents = [{ path: 'index.literate', text:
        fence('text: <<root.*>>= result.txt $', '<<piece>>/<<piece>>\n\\<<piece>>') +
        fence('text: <<piece>>=', '$& $` $\' \\<<missing>>')
    }];
    const result = generateProject(documents);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.files.find(file => file.path === 'result.txt')?.content,
        '$& $` $\' <<missing>>/$& $` $\' <<missing>>\n<<piece>>\n');
    assert.equal(collectFragmentOccurrences(documents).filter(item => item.kind === 'reference').length, 2);
});
