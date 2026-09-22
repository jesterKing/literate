import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import type * as vscode from 'vscode';
import { fixture, fence } from './vscode-fixture';

async function preview() {
    const f = fixture();
    const api = await f.extension.activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    return { ...f, extend: (md: MarkdownIt) => api.extendMarkdownIt(md) as MarkdownIt };
}

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
        assert.equal(md.render(text), baseline.render(text), info);
    }
    assert.equal(calls.length, 7);
    assert.equal(md.render(fence('SETTINGS', 'template=private')), '');
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
        assert.equal(first.render(fence('text', 'one')), '<pre>first</pre>');
        assert.equal(second.render(fence('text', 'two')), '<pre>second</pre>');
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

test('fragment filenames and labels cannot inject preview HTML', async () => {
    const { extend } = await preview();
    const md = extend(new MarkdownIt());
    const html = md.render(fence('text: <<safe & "label">>= out" onmouseover="bad&.txt $', '<script>bad</script>'));
    assert.ok(html.includes('&lt;&lt;safe &amp; &quot;label&quot;&gt;&gt;='));
    assert.ok(html.includes('out&quot; onmouseover=&quot;bad&amp;.txt'));
    assert.ok(!html.includes('<script>'));
});
