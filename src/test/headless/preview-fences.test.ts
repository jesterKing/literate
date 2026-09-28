import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import type * as vscode from 'vscode';
import { fixture, fence } from './vscode-fixture';

async function preview(f = fixture()) {
    const subscriptions: vscode.Disposable[] = [];
    const api = await f.extension.activate({ subscriptions } as unknown as vscode.ExtensionContext);
    const repository = subscriptions.find(value => value instanceof f.extension.FragmentRepository) as
        InstanceType<typeof f.extension.FragmentRepository>;
    // Activation creates a new repository and collection, independent of the fixture's initial repository.
    const diagnostics = f.diagnosticCollections.get('literate')!.diagnostics;
    return { ...f, repository, diagnostics,
        process: (folder = f.folder) => repository.processLiterateFiles(folder as unknown as vscode.WorkspaceFolder),
        extend: (md: MarkdownIt) => api.extendMarkdownIt(md) as MarkdownIt };
}

const wrapped = (body: string, theme = 'rosepine-dawn') =>
    `<div class="literate-document" data-literate-theme="${theme}">${body}</div>`;

test('plain Mermaid preserves and escapes original source with source-line metadata', async () => {
    const { extend } = await preview();
    const md = extend(new MarkdownIt({ highlight: () => { throw new Error('must bypass highlighting'); } }));
    const source = 'graph TD\nA["</pre><script>alert(1)</script> & \\<<literal>>"]\n';
    const tokens = md.parse('Intro\n\n' + fence('  mermaid \t', source), {});
    const token = tokens.find(item => item.type === 'fence')!;
    const html = md.renderer.render(tokens, md.options, {});
    assert.ok(html.includes('<pre class="literate-mermaid source-line" data-line="2">'
        + md.utils.escapeHtml(source) + '</pre>'));
    assert.ok(!html.includes('<script>'));
    assert.equal(token.content, source);
    assert.deepEqual(token.map, [2, 6]);
});

test('ordinary fences delegate unchanged and Mermaid matching is exact', async () => {
    const { extend } = await preview();
    const md = new MarkdownIt();
    const original = md.renderer.rules.fence!;
    const calls: string[] = [];
    md.renderer.rules.fence = (tokens, idx, options, env, renderer) => {
        calls.push(tokens[idx].info);
        return original(tokens, idx, options, env, renderer);
    };
    extend(md);
    const baseline = new MarkdownIt();
    for (const info of ['', 'ts', 'notmermaid', 'x mermaid', 'mermaid extra', 'Mermaid', 'ts <<not a declaration>>=']) {
        const text = fence(info, '\\<<literal>> <b>&');
        assert.equal(md.render(text), wrapped(baseline.render(text)), info);
    }
    assert.equal(calls.length, 7);
    assert.equal(md.render(fence('SETTINGS', 'template=private')), wrapped(''));
    assert.equal(calls.length, 7, 'hidden settings must not delegate');
});

test('each preview retains its original fence rule even after internal parsing', async () => {
    const f = await preview();
    const first = new MarkdownIt();
    const second = new MarkdownIt();
    first.renderer.rules.fence = () => '<pre>first</pre>';
    second.renderer.rules.fence = () => '<pre>second</pre>';
    f.extend(first);
    f.extend(second);
    f.put('index.literate', fence('text: <<main>>=', 'content'));
    await f.process();
    for (let i = 0; i < 3; i++) {
        assert.equal(first.render(fence('text', 'one')), wrapped('<pre>first</pre>'));
        assert.equal(second.render(fence('text', 'two')), wrapped('<pre>second</pre>'));
        assert.equal((first.render(fence('text: <<named>>=', 'one')).match(/class="codefragment"/g) || []).length, 1);
    }
    assert.deepEqual(f.writes, []);
});

test('named Mermaid declarations and appends remain escaped code, bypassing third-party rendering', async () => {
    const { extend } = await preview();
    const md = new MarkdownIt({ highlight: () => { throw new Error('third-party highlighter'); } });
    md.renderer.rules.fence = () => { throw new Error('third-party Mermaid renderer'); };
    extend(md);
    for (const suffix of ['=', '=+']) {
        const source = 'graph TD\nA["</code></pre><img src=x onerror=alert(1)>"]\n\\<<literal>>\n';
        const tokens = md.parse(fence('mermaid: <<diagram & "label">>' + suffix, source), {});
        const html = md.renderer.render(tokens, md.options, {});
        assert.ok(html.includes('class="codefragment"'));
        assert.ok(html.includes('&lt;&lt;diagram &amp; &quot;label&quot;&gt;&gt;' + suffix));
        assert.ok(html.includes('<pre><code class="language-mermaid">'
            + md.utils.escapeHtml(source.replace('\\<<', '<<')) + '</code></pre>'));
        assert.ok(!html.includes('literate-mermaid'));
        assert.ok(!html.includes('<img'));
        assert.equal(tokens[0].content, source);
    }
});

test('render wrapper preserves parser closure, receiver, tokens and render-time document URI', async () => {
    const f = await preview();
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine-dawn'));
    const md = new MarkdownIt();
    const original = md.renderer.render;
    let calls = 0;
    md.renderer.render = function (tokens, options, env) {
        assert.equal(this, md.renderer);
        calls++;
        return original.call(this, tokens, options, env);
    };
    f.extend(md);
    const tokens = md.parse('# Heading', {});
    assert.equal(calls, 0, 'parsing does not render or wrap');
    assert.equal(tokens[0].type, 'heading_open');
    const env = { currentDocument: f.document('chapter.literate', '').uri };
    assert.equal(md.renderer.render(tokens, md.options, env), wrapped('<h1>Heading</h1>\n', 'rosepine-dawn'));
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine'));
    assert.equal(md.renderer.render(tokens, md.options, env), wrapped('<h1>Heading</h1>\n', 'rosepine'));
    assert.equal(calls, 2);
    const inlineTokens = md.parseInline('*inline*', env)[0].children!;
    assert.equal(md.renderer.renderInline(inlineTokens, md.options, env), '<em>inline</em>');
    assert.deepEqual(f.writes, []);
});

test('project root themes prefer unsaved buffers and never leak between same-named folders', async () => {
    const f = await preview();
    f.other.name = f.folder.name;
    f.put('index.literate', fence('SETTINGS', 'theme=rosepine'));
    f.put('index.literate', fence('SETTINGS', 'theme=rosepine-dawn'), f.other);
    await f.process();
    await f.process(f.other);
    const md = f.extend(new MarkdownIt());
    const text = fence('SETTINGS', 'theme=not-a-theme') + 'Chapter';
    const render = (folder = f.folder) => md.render(text,
        { currentDocument: f.document('nested/chapter.md', '', folder).uri });
    assert.equal(render(), wrapped('<p>Chapter</p>\n', 'rosepine'));
    assert.equal(render(f.other), wrapped('<p>Chapter</p>\n', 'rosepine-dawn'));
    f.open('nested/index.literate', fence('SETTINGS', 'theme=rosepine-dawn'));
    f.open('index.literate', '');
    assert.equal(render(), wrapped('<p>Chapter</p>\n'));
    assert.equal(render(f.other), wrapped('<p>Chapter</p>\n', 'rosepine-dawn'));
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine'));
    assert.equal(render(), wrapped('<p>Chapter</p>\n', 'rosepine'));
    assert.deepEqual(f.writes, []);
});

test('standalone and missing-document previews default, ignoring local SETTINGS', async () => {
    const f = await preview();
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine'));
    const md = f.extend(new MarkdownIt());
    const text = fence('SETTINGS', 'theme=rosepine') + 'Standalone';
    assert.equal(md.render(text), wrapped('<p>Standalone</p>\n'));
    assert.equal(md.render(text, { currentDocument: f.mock.Uri.file('/outside/book.md') }),
        wrapped('<p>Standalone</p>\n'));
    assert.equal(md.render(''), wrapped(''));
    assert.deepEqual(f.writes, []);
});

test('invalid root theme diagnostics force the preview default, even after a valid choice', async () => {
    const setup = fixture();
    const f = await preview(setup);
    const languageDiagnostics = f.diagnosticCollections.get('literate-language')!;
    assert.notEqual(f.diagnostics, setup.diagnostics);
    assert.notEqual(f.diagnostics, languageDiagnostics.diagnostics);
    const md = f.extend(new MarkdownIt());
    for (const invalid of ['', 'unknown', '\" onmouseover=\"bad', '</div><script>bad</script>']) {
        f.open('index.literate', fence('SETTINGS', 'theme=rosepine\ntheme=' + invalid));
        assert.equal(md.render('Safe', { currentDocument: f.document('chapter.literate', '').uri }),
            wrapped('<p>Safe</p>\n'));
        await f.process();
        assert.ok([...f.diagnostics.values()].flat().some(value => /theme/i.test(value.message)));
        assert.equal(setup.diagnostics.size, 0, 'preview processing uses the activated repository');
        const problems = [...f.diagnostics.entries()];
        languageDiagnostics.clear();
        assert.deepEqual([...f.diagnostics.entries()], problems, 'clearing language diagnostics preserves engine problems');
        f.workspace.textDocuments = [];
        assert.equal(md.render('Safe', { currentDocument: f.document('chapter.literate', '').uri }),
            wrapped('<p>Safe</p>\n'), 'invalid snapshot also defaults');
    }
    assert.deepEqual(f.writes, []);
});

test('remote snapshots refresh previews only when the effective theme changes', async () => {
    const f = await preview(fixture('vscode-remote://ssh-remote+host/project'));
    const md = f.extend(new MarkdownIt());
    const env = { currentDocument: f.document('chapter.literate', '').uri };
    const assertCommands = (refreshes: number) => {
        const expected = [
            { name: 'setContext', args: ['literate.automaticCompletionPending', false] },
            ...Array.from({ length: refreshes }, () => ({ name: 'markdown.preview.refresh', args: [] }))
        ];
        assert.deepEqual(f.executedCommandCalls, expected);
        assert.deepEqual(f.executedCommands, expected.map(call => call.name));
    };
    assertCommands(0);
    f.put('index.literate', fence('SETTINGS', 'theme=rosepine'));
    await f.process();
    assert.equal(md.render('Remote', env), wrapped('<p>Remote</p>\n', 'rosepine'));
    assertCommands(1);
    await f.process();
    f.put('chapter.literate', 'Unrelated edit');
    await f.process();
    assertCommands(1);
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine-dawn'));
    await f.process();
    assertCommands(2);
    assert.equal(md.render('Remote', env), wrapped('<p>Remote</p>\n', 'rosepine-dawn'));
    f.open('index.literate', fence('SETTINGS', 'theme=rosepine'));
    await f.process();
    assertCommands(3);
    assert.equal(md.render('Remote', env), wrapped('<p>Remote</p>\n', 'rosepine'));
    f.open('index.literate', fence('SETTINGS', 'theme=invalid'));
    await f.process();
    await f.process();
    assertCommands(4);
    assert.equal(md.render('Remote', env), wrapped('<p>Remote</p>\n'));
    assert.deepEqual(f.writes, []);
});

test('activation has the root snapshot ready before returning the preview plugin', async () => {
    const setup = fixture();
    setup.put('index.literate', fence('SETTINGS', 'theme=rosepine\ntemplate=missing.template'));
    const f = await preview(setup);
    const md = f.extend(new MarkdownIt());
    assert.equal(md.render('Ready', { currentDocument: f.document('chapter.literate', '').uri }),
        wrapped('<p>Ready</p>\n', 'rosepine'));
    assert.deepEqual(f.writes, [], 'invalid template prevents activation output writes');
});

test('fragment filenames and labels cannot inject preview HTML', async () => {
    const { extend } = await preview();
    const md = extend(new MarkdownIt());
    const html = md.render(fence('text: <<safe & "label">>= out" onmouseover="bad&.txt $', '<script>bad</script>'));
    assert.ok(html.includes('&lt;&lt;safe &amp; &quot;label&quot;&gt;&gt;='));
    assert.ok(html.includes('out&quot; onmouseover=&quot;bad&amp;.txt'));
    assert.ok(!html.includes('<script>'));
});
