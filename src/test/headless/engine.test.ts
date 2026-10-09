/* Fixture dictionaries intentionally use filesystem paths as property names. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import { discoveryExcludedDirectories, generateProject, resolveProjectTheme, safeRelativePath, SourceDocument } from '../../engine';
import { defaultThemeName, getTheme, themeCss, themes } from '../../themes';

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

test('5000 nested fragments preserve indentation, escapes, appends, and cached reuse', () => {
    const depth = 5000;
    const parts = [root('  <<part0>>\n\t<<part0>>')];
    for (let index = 0; index < depth; index++) {
        parts.push(fence('text: <<part' + index + '>>=', index + 1 < depth
            ? '<<part' + (index + 1) + '>>' : 'first\n\\<<literal>>\n\nlast $&'));
    }
    parts.push(fence('text: <<part' + (depth - 1) + '>>=+', 'appended'));
    const lines = ['first', '<<literal>>', '', 'last $&', 'appended'];
    assert.equal(output(parts.join('')), lines.map(line => '  ' + line + '\n').join('')
        + lines.map(line => '\t' + line + '\n').join(''));
});

test('a cycle in 5000 unused nested fragments reports its full path without overflowing', () => {
    const depth = 5000;
    const parts = [root('valid')];
    const names = Array.from({ length: depth }, (_, index) => 'part' + index);
    for (let index = 0; index < depth; index++) {
        parts.push(fence('text: <<' + names[index] + '>>=', '<<' + names[index + 1 < depth ? index + 1 : 2500] + '>>'));
    }
    const result = generateProject([document(parts.join(''))]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, [{
        path: 'index.literate', line: depth * 3 + 1, column: 0,
        message: 'Fragment cycle: ' + names.concat('part2500').join(' -> '),
    }]);
});

test('depth-first diagnostics retain reference positions and cache invalid dependencies', () => {
    const text = root('<<a>>\n<<a>>')
        + fence('text: <<a>>=', '<<b>>=\n<<missing>>')
        + fence('text: <<b>>=', '<<a>>\n<<nested missing>>')
        + fence('text: <<a>>=+', '<<b>>=+\n<<absent>>')
        + fence('text: <<unused>>=', '<<unused>>');
    const result = generateProject([document(text)]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, [
        { line: 5, message: 'Invalid definition operator on reference: b' },
        { line: 9, message: 'Fragment cycle: main.* -> a -> b -> a' },
        { line: 10, message: 'Missing fragment: nested missing', code: 'missing-fragment' },
        { line: 6, message: 'Missing fragment: missing', code: 'missing-fragment' },
        { line: 13, message: 'Invalid definition operator on reference: b' },
        { line: 14, message: 'Missing fragment: absent', code: 'missing-fragment' },
        { line: 17, message: 'Fragment cycle: unused -> unused' },
    ].map(diagnostic => ({ path: 'index.literate', column: 0, ...diagnostic })));
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
    const content = '<style>' + themeCss(getTheme(defaultThemeName)!) + '</style>'
        + '<div class="literate-document" data-literate-theme="rosepine-dawn">'
        + '<p>Prose [AUTHORS] [CONTENT] $&amp; $$</p>\n</div>';
    assert.equal(html, authors + '|' + content + '|' + authors + '|' + content + '|[CODE]');
});

test('theme query defaults and reads only the normalized root SETTINGS', () => {
    assert.deepEqual(resolveProjectTheme([]), { name: 'rosepine-dawn', diagnostics: [] });
    assert.deepEqual(resolveProjectTheme([
        document(fence('SETTINGS', 'theme=unknown'), 'nested/index.literate'),
        document(fence('SETTINGS', 'theme='), 'chapter.literate'),
        document('theme=unknown\n' + fence('text', 'theme=unknown')
            + fence('SETTINGS', 'ignored=unknown\n theme = rosepine '), './nested/../index.literate'),
    ]), { name: 'rosepine', diagnostics: [] });
    assert.deepEqual(resolveProjectTheme([document(fence('SETTINGS', 'unknown=value'))]),
        { name: 'rosepine-dawn', diagnostics: [] });
    assert.equal(resolveProjectTheme([document(fence('SETTINGS', 'theme=rosepine')
        + fence('SETTINGS', 'theme=rosepine-dawn'))]).name, 'rosepine-dawn');
});

test('invalid themes retain exact diagnostic lines, suppress outputs, and preserve inspection', () => {
    const text = '# Project\n\n' + fence('SETTINGS', 'theme=rosepine\ntheme=\ntheme=not-a-theme')
        + fence('SETTINGS', 'theme=rosepine-dawn\ntheme=Rosepine-Dawn') + root('unchanged');
    const expected = [
        { line: 4, message: 'Unknown theme: ' },
        { line: 5, message: 'Unknown theme: not-a-theme' },
        { line: 9, message: 'Unknown theme: Rosepine-Dawn' },
    ].map(value => ({ path: 'index.literate', column: 0, ...value }));
    for (const ending of ['\n', '\r\n', '\r']) {
        const docs = [document(text.replace(/\n/g, ending), './index.literate')];
        assert.deepEqual(resolveProjectTheme(docs), { name: 'rosepine-dawn', diagnostics: expected });
        const result = generateProject(docs);
        assert.deepEqual(result.diagnostics, expected, 'theme diagnostics appear only once');
        assert.deepEqual(result.files, []);
        assert.deepEqual(result.inspection.documents, ['index.literate']);
        assert.equal(result.inspection.fragments[0].name, 'main.*');
    }
});

test('every canonical theme embeds its CSS and uses the local Mermaid runtime project-wide', () => {
    for (const theme of themes) {
        const files = successful([
            document(fence('SETTINGS', 'theme=' + theme.name) + root('unchanged')),
            document('# Chapter\n' + fence('mermaid', 'graph TD\n A-->B'), 'nested/chapter.literate'),
        ]);
        assert.equal(files.find(file => file.path === 'result.txt')!.content, 'unchanged\n');
        for (const file of files.filter(value => value.path.endsWith('.html'))) {
            assert.ok(file.content.includes('<style>' + themeCss(theme) + '</style>'));
            assert.ok(file.content.includes('<div class="literate-document" data-literate-theme="' + theme.name + '">'));
            assert.ok(!file.content.includes('href="./style.css"'));
            assert.doesNotMatch(file.content, /<script[^>]+https?:|import\s+[^;]+https?:/);
            const prefix = file.path.includes('/') ? '../' : './';
            assert.ok(file.content.includes(`<script defer src="${prefix}out/mermaid-preview.js"></script>`));
        }
        assert.match(files.find(file => file.path === 'nested/chapter.html')!.content, /<pre class="literate-mermaid">/);
    }
});

test('default HTML has accessible metadata, a local runtime, and injection-safe settings', () => {
    const html = successful([document('# Default')])[0].content;
    assert.ok(html.includes('<style>' + themeCss(getTheme(defaultThemeName)!) + '</style>'));
    assert.match(html, /data-literate-theme="rosepine-dawn"/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta charset="utf-8" \/>/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.match(html, /<title>Default<\/title>/);
    assert.match(html, /<script defer src="\.\/out\/mermaid-preview\.js"><\/script>/);
    assert.doesNotMatch(html, /<script[^>]+https?:|import\s+[^;]+https?:/);
    rejected([document(fence('SETTINGS', 'theme=</script><script>alert(1)</script>') + root('safe'))], /Unknown theme/);
});

test('explicit THEME slots replace literally and do not duplicate the sheet in CONTENT', () => {
    const text = fence('SETTINGS', 'template=page.template\nauthors=[THEME]') + 'Prose [THEME]\n';
    const sheet = '<style>' + themeCss(getTheme(defaultThemeName)!) + '</style>';
    const content = '<div class="literate-document" data-literate-theme="rosepine-dawn"><p>Prose [THEME]</p>\n</div>';
    const html = successful([document(text)], {
        'page.template': '[TITLE]|[PREVIEW]|[THEME]|[CONTENT]|[THEME]|[CONTENT]|[AUTHORS]|[CODE]',
    })[0].content;
    assert.equal(html, 'index.literate|<script defer src="./out/mermaid-preview.js"></script>|'
        + sheet + '|' + content + '|' + sheet + '|' + content
        + '|<meta name="author" content="[THEME]">|[CODE]');
    assert.equal(output(fence('text: <<main.*>>= result.txt $ template=source.template', '[THEME]'),
        { 'source.template': '[THEME]|[CODE]|[THEME]' }), '[THEME]|[THEME]\n|[THEME]');
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
    assert.deepEqual(result.diagnostics, [{ path: 'index.literate', line: 2, column: 2, message: 'Missing fragment: missing', code: 'missing-fragment' }]);
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
