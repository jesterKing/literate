/* Fixture dictionaries intentionally use filesystem paths as property names. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import { discoveryExcludedDirectories, generateProject, safeRelativePath, SourceDocument } from '../../engine';

function fence(header: string, content = ''): string {
    return '```' + header + '\n' + content + (content && !content.endsWith('\n') ? '\n' : '') + '```\n';
}

function document(text: string, path = 'index.literate'): SourceDocument {
    return { path, text };
}

function successful(documents: SourceDocument[], templates: Record<string, string> = {}) {
    const result = generateProject(documents, templates);
    assert.deepEqual(result.diagnostics, []);
    return result.files;
}

function output(text: string, templates: Record<string, string> = {}): string {
    const files = successful([document(text)], templates);
    const file = files.find(value => value.path === 'result.txt');
    assert.ok(file, 'expected result.txt in generated files');
    return file.content;
}

function rejected(documents: SourceDocument[], message: RegExp, templates: Record<string, string> = {}): void {
    const result = generateProject(documents, templates);
    assert.deepEqual(result.files, [], 'diagnostics must suppress all source and HTML output');
    assert.ok(result.diagnostics.some(value => message.test(value.message)), JSON.stringify(result.diagnostics));
    for (const diagnostic of result.diagnostics) {
        assert.equal(typeof diagnostic.path, 'string');
        assert.ok(Number.isInteger(diagnostic.line) && diagnostic.line >= 0);
        assert.ok(Number.isInteger(diagnostic.column) && diagnostic.column >= 0);
    }
}

const root = (content: string) => fence('text: <<main.*>>= result.txt $', content);

test('LF, CRLF, CR and mixed inputs generate identical source, HTML and inspection', () => {
    const docs = [
        document(fence('SETTINGS', 'template=page.template\nauthors=Example')
            + '# Example\n\n' + fence('text: <<main.*>>= result.txt $ template=source.template',
                'begin\n  <<part>>\nend')),
        document(fence('text: <<part>>=', 'first\nsecond'), 'part.literate'),
    ];
    const templates = {
        'source.template': 'before\n[CODE]after\n',
        'page.template': '<html>\n[AUTHORS]\n[CONTENT]\n</html>\n',
    };
    const expected = generateProject(docs, templates);
    assert.deepEqual(expected.diagnostics, []);
    for (const endings of [['\n'], ['\r\n'], ['\r'], ['\n', '\r\n', '\r']]) {
        const convert = (text: string) => {
            let index = 0;
            return text.replace(/\n/g, () => endings[index++ % endings.length]);
        };
        const actual = generateProject(docs.map(doc => ({ ...doc, text: convert(doc.text) })),
            Object.fromEntries(Object.entries(templates).map(([path, text]) => [path, convert(text)])));
        assert.deepEqual(actual, expected, JSON.stringify(endings));
        assert.ok(actual.files.every(file => !file.content.includes('\r')));
    }
});

test('replacement sequences remain literal through fragment and source-template substitution', () => {
    const literal = "$& $$ $` $' $1 $99 \\path [CODE] [CONTENT] [AUTHORS]";
    const text = fence('text: <<main.*>>= result.txt $ template=source.template', '<<value>>\n<<value>>')
        + fence('text: <<value>>=', literal);
    assert.equal(output(text, { 'source.template': 'before\n[CODE]after\n[CODE]' }),
        'before\n' + literal + '\n' + literal + '\nafter\n' + literal + '\n' + literal + '\n');
});

test('nested multiline references preserve spaces, tabs, and blank lines', () => {
    const text = root('begin\n  <<middle>>\n\t<<leaf>>\nend')
        + fence('text: <<middle>>=', 'one\n  <<leaf>>\nthree')
        + fence('text: <<leaf>>=', 'alpha\n\nbeta');
    assert.equal(output(text), 'begin\n  one\n    alpha\n    \n    beta\n  three\n\talpha\n\t\n\tbeta\nend\n');
});

test('repeated and inline references expand every occurrence without losing surrounding text', () => {
    assert.equal(output(root('<<word>>/<<word>>\nprefix <<lines>> suffix\n<<word>>')
        + fence('text: <<word>>=', 'W') + fence('text: <<lines>>=', 'A\nB')),
    'W/W\nprefix A\n B suffix\nW\n');
});

test('empty fragments, empty top-level files, and append-to-empty fragments are supported', () => {
    assert.equal(output(root('')), '');
    assert.equal(output(root('before<<empty>>after\n<<joined>>')
        + fence('text: <<empty>>=') + fence('text: <<joined>>=')
        + fence('text: <<joined>>=+', 'first') + fence('text: <<joined>>=+')
        + fence('text: <<joined>>=+', 'last')), 'beforeafter\nfirst\nlast\n');
});

test('forward references resolve across documents', () => {
    const files = successful([
        document(root('<<later>>')),
        document(fence('text: <<later>>=', 'resolved'), 'z.literate'),
    ]);
    assert.equal(files.find(file => file.path === 'result.txt')?.content, 'resolved\n');
});

test('escaped literal openers become << without expansion, including nested references', () => {
    assert.equal(output(root('\\<<missing>>\n\\<<defined>>\n<<wrapper>>\n<<defined>>')
        + fence('text: <<wrapper>>=', '\\<<defined>>\n\\<<also missing>>')
        + fence('text: <<defined>>=', 'EXPANDED')),
    '<<missing>>\n<<defined>>\n<<defined>>\n<<also missing>>\nEXPANDED\n');
});

test('last code and prose lines survive closed fences and EOF without a newline', () => {
    assert.equal(output(root('first\nlast').trimEnd()), 'first\nlast\n');
    assert.equal(output('```text: <<main.*>>= result.txt $\nfirst\nlast'), 'first\nlast');
    const files = successful([document(root('last') + '\nFinal prose without newline')]);
    assert.match(files.find(file => file.path === 'index.html')!.content, /<p>Final prose without newline<\/p>/);
});

test('HTML templates replace repeated placeholders literally in a single pass', () => {
    const text = fence('SETTINGS', 'template=page.template\nauthors=Alice [CONTENT] [AUTHORS] $& $$')
        + 'Prose [AUTHORS] [CONTENT] $& $$\n';
    const html = successful([document(text)], {
        'page.template': '[AUTHORS]|[CONTENT]|[AUTHORS]|[CONTENT]|[CODE]',
    })[0].content;
    const authors = '<meta name="author" content="Alice [CONTENT] [AUTHORS] $&amp; $$">';
    const content = '<p>Prose [AUTHORS] [CONTENT] $&amp; $$</p>\n';
    assert.equal(html, authors + '|' + content + '|' + authors + '|' + content + '|[CODE]');
});

test('root index links define order, followed by sorted remaining documents, independent of input order', () => {
    const docs = [
        document(fence('text: <<order>>=+', 'Z'), 'z.literate'),
        document(fence('text: <<order>>=+', 'A'), 'a.literate'),
        document(fence('text: <<order>>=+', 'linked'), 'chapter two.literate'),
        document('[chapter](chapter%20two.html#section)\n[again](chapter%20two.literate?x=1)\n'
            + root('<<order>>') + fence('text: <<order>>=', 'index')),
    ];
    const expected = successful(docs);
    assert.deepEqual(successful([...docs].reverse()), expected);
    assert.deepEqual(successful([docs[1], docs[3], docs[0], docs[2]]), expected);
    assert.deepEqual(expected.map(file => file.path), ['result.txt', 'index.html', 'chapter two.html', 'a.html', 'z.html']);
    assert.equal(expected[0].content, 'index\nlinked\nA\nZ\n');
});

for (const [name, broken, message] of [
    ['missing reference', root('<<missing>>'), /Missing fragment: missing/],
    ['unused missing reference', root('valid') + fence('text: <<unused>>=', '<<missing>>'), /Missing fragment/],
    ['self cycle', root('valid') + fence('text: <<a>>=', '<<a>>'), /Fragment cycle/],
    ['indirect cycle', root('<<a>>') + fence('text: <<a>>=', '<<b>>') + fence('text: <<b>>=', '<<a>>'), /Fragment cycle/],
    ['append without base', root('valid') + fence('text: <<unknown>>=+', 'bad'), /Cannot append to missing fragment/],
    ['duplicate fragment', root('valid') + fence('text: <<a>>=', 'one') + fence('text: <<a>>=', 'two'), /Duplicate fragment/],
    ['missing filename', fence('text: <<main.*>>=', 'bad'), /Missing filename/],
    ['missing template', fence('text: <<main.*>>= result.txt $ template=absent.template', 'bad'), /Missing template/],
] as const) {
    test(name + ' produces diagnostics and no output', () => rejected([document(broken)], message));
}

test('missing-reference diagnostics point to the zero-based reference position', () => {
    const result = generateProject([document(root('ok\n  <<missing>>'))]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, [{ path: 'index.literate', line: 2, column: 2, message: 'Missing fragment: missing' }]);
});

for (const path of ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'dir/../../escape.txt', 'dir\\escape.txt', '.', 'bad\u0000name']) {
    test('rejects invalid output filename ' + JSON.stringify(path), () => {
        rejected([document(fence('text: <<main.*>>= ' + path + ' $', 'bad'))], /Invalid output path/);
    });
}

test('spaces in filenames and safe path normalization are supported', () => {
    const files = successful([document(fence('text: <<main.*>>= generated folder/./unused/../my file.txt $', 'ok'))]);
    assert.equal(files[0].path, 'generated folder/my file.txt');
    assert.equal(files[0].content, 'ok\n');
});

test('normalized duplicate source and template paths are rejected', () => {
    rejected([document('one'), document('two', './index.literate')], /Duplicate source document/);
    rejected([document('ok')], /Duplicate template path/, { 'page.template': 'one', './page.template': 'two' });
});

test('source and template paths cannot escape the project', () => {
    rejected([document('bad', '../outside.literate')], /Invalid source path/);
    rejected([document('ok')], /Invalid template path/, { '../outside.template': 'bad' });
    rejected([document(fence('SETTINGS', 'template=../outside.template'))], /Invalid template path/);
    rejected([document(fence('text: <<main.*>>= result.txt $ template=../outside.template', 'bad'))], /Invalid template path/);
});

test('portable collision keys reject case aliases for inputs, templates, and all outputs', () => {
    rejected([document('one'), document('two', 'INDEX.LITERATE')], /Duplicate source document/);
    rejected([document('ok')], /Duplicate template path/, { 'Page.template': 'one', 'page.template': 'two' });
    rejected([document(fence('text: <<main.*>>= index.literate $', 'bad'), 'INDEX.LITERATE')], /Output collides with input/);
    rejected([document(fence('text: <<main.*>>= PAGE.template $', 'bad'))], /Output collides with input/, { 'page.template': 'template' });
    rejected([document(fence('text: <<main.*>>= INDEX.html $', 'bad'))], /Duplicate output path/);
    const pair = fence('text: <<first.*>>= Foo.ts $', 'one') + fence('text: <<second.*>>= foo.ts $', 'two');
    rejected([document(pair)], /Duplicate output path/);
    rejected([document('one', 'Chapter.literate')], /Output collides with input/, { 'CHAPTER.html': 'template' });
});

for (const path of [
    'dir/file:stream', 'dir./file', 'dir /file', 'file.', 'file ',
    'CON', 'nul.txt', 'dir/PrN.js', 'AUX', 'COM1.log', 'lpt9', 'COM¹.txt', 'LPT².txt',
    'con .txt', 'CONIN$', 'conout$.txt', 'bad?name', 'bad*name', 'bad|name', 'bad"name', 'bad<name', 'bad>name',
]) {
    test('portable paths reject Windows-invalid component ' + JSON.stringify(path), () => {
        assert.equal(safeRelativePath(path), undefined);
        rejected([document('bad', path)], /Invalid source path/);
        rejected([document('ok')], /Invalid template path/, { [path]: 'bad' });
        // Appending a child preserves trailing-space components through header whitespace parsing.
        rejected([document(fence('text: <<main.*>>= ' + path + '/child.txt $', 'bad'))], /Invalid output path/);
    });
}

test('portable path checks still allow internal parent traversal and non-device names', () => {
    assert.equal(safeRelativePath('./dir/../safe file.ts'), 'safe file.ts');
    for (const path of ['COM0', 'COM10.txt', 'LPT0', 'console.txt', 'auxiliary', '.config']) {
        assert.equal(safeRelativePath(path), path);
    }
});

test('file/directory output conflicts are rejected in either reservation order and case', () => {
    for (const paths of [['Build', 'build/file.ts'], ['build/file.ts', 'Build']]) {
        rejected([document(fence('text: <<first.*>>= ' + paths[0] + ' $', 'one')
            + fence('text: <<second.*>>= ' + paths[1] + ' $', 'two'))], /Output ancestor conflict/);
    }
    rejected([document(fence('text: <<main.*>>= INDEX.HTML/child $', 'bad'))], /Output ancestor conflict/);
    rejected([document(fence('text: <<main.*>>= CHAPTERS $', 'bad')), document('chapter', 'chapters/one.literate')], /Output\/input ancestor conflict/);
    rejected([document(fence('text: <<main.*>>= INDEX.LITERATE/child $', 'bad'))], /Output\/input ancestor conflict/);
    for (const [outputPath, templatePath] of [['Assets', 'assets/page.template'], ['ASSETS/page.ts', 'assets']]) {
        rejected([document(fence('text: <<main.*>>= ' + outputPath + ' $', 'bad'))], /Output\/input ancestor conflict/, { [templatePath]: 'template' });
    }
    successful([document(fence('text: <<main.*>>= building/file.ts $', 'ok'))], { 'build': 'template' });
});

test('final source and HTML outputs normalize template CRLF and bare CR to LF', () => {
    const text = fence('SETTINGS', 'template=page.template')
        + fence('text: <<main.*>>= result.txt $ template=source.template', 'code');
    const files = successful([document(text)], {
        'source.template': 'before\r\n[CODE]after\rend',
        'page.template': 'before\r\n[CONTENT]\r[AUTHORS]\rend\r\n',
    });
    assert.equal(files.find(file => file.path === 'result.txt')!.content, 'before\ncode\nafter\nend');
    const html = files.find(file => file.path === 'index.html')!.content;
    assert.ok(html.startsWith('before\n'));
    assert.ok(html.endsWith('\nend\n'));
    for (const file of files) { assert.ok(!file.content.includes('\r')); }
    assert.deepEqual(successful([document(text.replace(/\n/g, '\r\n'))], {
        'source.template': 'before\n[CODE]after\nend',
        'page.template': 'before\n[CONTENT]\n[AUTHORS]\nend\n',
    }), files);
});

test('adapters share an immutable discovery exclusion list', () => {
    assert.deepEqual(discoveryExcludedDirectories, ['.git', 'node_modules', 'out', 'dist', '.yarn', '.vscode-test']);
    assert.ok(Object.isFrozen(discoveryExcludedDirectories));
});

test('normalized duplicate output paths and source/HTML/template collisions are rejected atomically', () => {
    rejected([document(root('one') + fence('text: <<other.*>>= sub/../result.txt $', 'two'))], /Duplicate output path/);
    rejected([document(fence('text: <<main.*>>= index.html $', 'bad'))], /Duplicate output path/);
    rejected([document(fence('text: <<main.*>>= index.literate $', 'bad'))], /Output collides with input/);
    rejected([document(fence('text: <<main.*>>= page.template $', 'bad'))], /Output collides with input/, { 'page.template': '[CONTENT]' });
});
