import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import hljs from 'highlight.js';
import type * as vscode from 'vscode';
import { generateProject, parseProject, PublicationModel, PublicationSegment, ParsedDocumentBlock } from '../../engine';
import { renderLatex } from '../../publication-latex';
import { runPandoc } from '../../cli';
import { fixture, fence } from './vscode-fixture';

const caller = 'before <<a/b>> / <<a-b>> / <<a/b>> after\n\\<<literal>>';
const quoted = (text: string) => text.trimEnd().split('\n').map(line => '> ' + line).join('\n') + '\n';
function documents(prefix = '') {
    return [
        { path: 'more.literate', text: '# More\n\n' + fence('text: <<a/b>>=+', 'third') },
        { path: 'defs.literate', text: '# Definitions\n\n[More](more.html)\n\n'
            + quoted(fence('text: <<a/b>>=', 'first'))
            + fence('text: <<a-b>>=', 'other') + fence('text: <<a/b>>=+', 'second') },
        { path: 'index.literate', text: prefix + '# Book\n\n[Definitions](defs.html)\n\n'
            + fence('text', '<<ordinary>>')
            + fence('text: <<main.*>>= result.txt $', caller) }
    ];
}
const expected = new Map<string, { name: string; kind: string; body: string }[]>([
    ['index.literate', [{ name: 'main.*', kind: 'definition', body: caller.replace('\\<<', '<<') + '\n' }]],
    ['defs.literate', [
        { name: 'a/b', kind: 'definition', body: 'first\n' },
        { name: 'a-b', kind: 'definition', body: 'other\n' },
        { name: 'a/b', kind: 'append', body: 'second\n' }
    ]],
    ['more.literate', [{ name: 'a/b', kind: 'append', body: 'third\n' }]]
]);
const escape = new MarkdownIt().utils.escapeHtml;
function textContent(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot|#39);/g,
        (_, entity: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[entity]!);
}
function blocks(html: string) {
    const found = [...html.matchAll(/<div class="codefragment">\s*<div class="fragmentname">([^]*?)<\/div>\s*<div class="code">([^]*?)<\/div>\s*<\/div>/g)];
    assert.equal(found.length, (html.match(/class="codefragment"/g) || []).length);
    return found.map(match => ({ label: textContent(match[1]).trim(), code: match[2] }));
}
function references(model: PublicationModel) {
    return model.contributions.flatMap(part => part.segments.filter(
            (segment): segment is Extract<PublicationSegment, { kind: 'reference' }> => segment.kind === 'reference'));
}
async function preview() {
    const f = fixture();
    const subscriptions: vscode.Disposable[] = [];
    const api = await f.extension.activate({ subscriptions } as unknown as vscode.ExtensionContext);
    const md = new MarkdownIt({ highlight: (code, language) =>
        hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : '' });
    const delegated: { index: number; token: Token }[] = [];
    const original = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
        delegated.push({ index, token: tokens[index] });
        return original(tokens, index, options, env, renderer);
    };
    api.extendMarkdownIt(md);
    return { md, delegated, dispose: () => subscriptions.forEach(value => value.dispose()) };
}
function checkBlocks(html: string, path: string, model: PublicationModel, format: 'html' | 'preview') {
    const rendered = blocks(html);
    const wanted = expected.get(path)!;
    const parts = model.contributions.filter(part => part.definition.path === path);
    assert.equal(rendered.length, wanted.length);
    assert.equal(parts.length, wanted.length);
    return rendered.map((block, index) => {
        const want = wanted[index], part = parts[index];
        const family = model.fragments.find(value => value.name === want.name)!;
        assert.ok(family);
        assert.equal(part.kind, want.kind);
        assert.equal(part.fragmentTarget, family.target);
        assert.ok(family.contributions.includes(part.target));
        const label = `<<${want.name}>>=${want.kind === 'append' ? '+' : ''}`;
        const suffix = want.name === 'main.*' ? (format === 'html' ? ' result.txt $' : ' result.txt') : '';
        assert.equal(block.label, label + suffix);
        const code = block.code.match(/<code\b[^>]*>([^]*?)<\/code>/);
        assert.ok(code);
        assert.equal(textContent(code[1]), want.body);
        assert.doesNotMatch(block.code, /<(?:a)\b|\bid=/);
        return part.target;
    });
}
for (const prefix of ['', 'Inserted prose.\n\n']) {
    test(`screen blocks map to publication contributions through real renderers (${prefix ? 'shifted' : 'original'})`, async () => {
        const inputs = documents(prefix), parsed = parseProject(inputs), generated = generateProject(inputs);
        assert.deepEqual(parsed.diagnostics, []);
        assert.deepEqual(generated.diagnostics, []);
        assert.deepEqual(parsed.documents.map(doc => doc.path), ['index.literate', 'defs.literate', 'more.literate']);
        assert.equal(generated.files.find(file => file.path === 'result.txt')?.content,
            'before first\n second\n third / other / first\n second\n third after\n<<literal>>\n');
        const p = await preview();
        try {
            for (const doc of parsed.documents) {
                p.delegated.length = 0;
                const env = {} as { gstate: { tokens: Token[] } };
                const screen = p.md.render(doc.source, env);
                const html = generated.files.find(file => file.path === doc.path.replace('.literate', '.html'))!.content;
                const targets = checkBlocks(html, doc.path, generated.publication, 'html');
                assert.deepEqual(checkBlocks(screen, doc.path, parsed.publication, 'preview'), targets);
                const contributions = doc.blocks.filter(
                        (block): block is Extract<ParsedDocumentBlock, { kind: 'contribution' }> => block.kind === 'contribution');
                assert.deepEqual(contributions.map(block => block.target), targets);
                for (const block of contributions) {
                    const part = parsed.publication.contributions.find(value => value.target === block.target)!;
                    const call = p.delegated.find(value => value.index === block.tokenIndex)!;
                    assert.ok(call, 'fragment delegated to the host renderer');
                    assert.equal(part.tokenIndex, block.tokenIndex);
                    assert.equal(env.gstate.tokens[block.tokenIndex].content, part.content);
                    assert.equal(call.token.content, part.content.replace(/\\<</g, '<<'));
                    assert.deepEqual(call.token.map, doc.tokens[block.tokenIndex].map);
                    assert.equal(call.token.map![0], part.definition.line);
                }
                assert.doesNotMatch(html + screen, /\bid="[fc]-/);
            }
            const model = parsed.publication, refs = references(model);
            assert.deepEqual(refs.map(ref => ref.name), ['a/b', 'a-b', 'a/b']);
            for (const ref of refs) {
                const family = model.fragments.find(value => value.name === ref.name)!;
                assert.deepEqual(ref.resolution, { kind: 'resolved', target: family.target });
                const definition = model.contributions.find(part => part.target === family.contributions[0])!;
                assert.equal(definition.kind, 'definition');
                assert.equal(definition.definition.path, 'defs.literate');
            }
            assert.notEqual(model.fragments[1].target, model.fragments[2].target);
            assert.deepEqual(model.fragments.find(value => value.name === 'a/b')!.contributions.map(target =>
                model.contributions.find(part => part.target === target)!.kind), ['definition', 'append', 'append']);
            assert.deepEqual(model.contributions.map(part => part.target),
                parseProject(documents()).publication.contributions.map(part => part.target));
        } finally { p.dispose(); }
    });
}
test('screen tag decoration is explicitly not a semantic reference or link', async () => {
    const inputs = documents(), generated = generateProject(inputs), p = await preview();
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const outputs = [generated.files.find(file => file.path === 'index.html')!.content,
            p.md.render(source.text, {})];
        for (const html of outputs) {
            const tags = [...blocks(html)[0].code.matchAll(/<span class="literate-tag-name">([^]*?)<\/span>/g)];
            assert.deepEqual(tags.map(match => textContent(match[1])),
                ['<<a/b>>', '<<a-b>>', '<<a/b>>', '<<literal>>']);
            assert.ok(html.includes(escape('<<ordinary>>')));
            assert.ok(!tags.some(match => match[1].includes('ordinary')));
            assert.doesNotMatch(blocks(html)[0].code, /<a\b/);
        }
        assert.equal(references(generated.publication).length, 3);
    } finally { p.dispose(); }
});
function highlightedDocuments(spaced = true) {
    const body = 'const s = "<<a/b>>";\nconst literal = "\\<<literal>> <a href=x>";\n// quiet comment';
    return [{ path: 'index.literate', text: fence((spaced ? 'js : ' : 'js: ') + '<<highlighted>>=', body)
        + fence('text: <<a/b>>=', 'value') }];
}
for (const spaced of [true, false]) {
test(`highlighted screen semantic/literal boundary (${spaced ? 'spaced' : 'compact'} header)`, async () => {
    const inputs = highlightedDocuments(spaced), generated = generateProject(inputs), p = await preview();
    try {
        assert.deepEqual(generated.diagnostics, []);
        const env = {} as { gstate: { tokens: Token[] } };
        const screen = p.md.render(inputs[0].text, env);
        for (const [format, html] of [['html', generated.files[0].content], ['preview', screen]]) {
            const code = blocks(html)[0].code;
            if (format === 'html' || spaced) {
                assert.match(code, /class="hljs-keyword"/);
                assert.match(code, /class="hljs-string"/);
                assert.doesNotMatch(code, /quiet comment/);
            } else {
                assert.doesNotMatch(code, /class="hljs-/);
                assert.match(code, /quiet comment/);
                assert.match(code, /class="language-js:"/);
            }
            assert.ok(code.includes(escape('<a href=x>')));
            assert.doesNotMatch(code, /<a\b/);
            const tags = [...code.matchAll(/<span class="literate-tag-name">([^]*?)<\/span>/g)];
            assert.deepEqual(tags.map(match => textContent(match[1])), ['<<a/b>>', '<<literal>>']);
        }
        assert.deepEqual(references(generated.publication).map(ref => ref.name), ['a/b']);
        assert.equal(p.delegated[0].token.info, (spaced ? 'js : ' : 'js: ') + '<<highlighted>>=');
        assert.equal(env.gstate.tokens[0].content, generated.publication.contributions[0].content);
    } finally { p.dispose(); }
});
}
function logicalTarget(encoded: string): string {
    assert.match(encoded, /^lit-(?:[0-9a-f]{4})+$/);
    return encoded.slice(4).match(/.{4}/g)!.map(unit => String.fromCharCode(parseInt(unit, 16))).join('');
}
for (const [name, inputs, count] of [['plain', documents(), 3], ['highlighted', highlightedDocuments(), 1]] as const) {
test(`real Pandoc LaTeX labels and reference macros map ${name} screens to shared targets`,
    { skip: process.env.LITERATE_TEST_PANDOC !== '1' }, async () => {
        const parsed = parseProject([...inputs]);
        const result = await renderLatex(parsed, {}, runPandoc);
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.latex);
        const labels = [...result.latex.matchAll(/\\label\{(lit-[0-9a-f]+)\}/g)].map(match => logicalTarget(match[1]));
        const targets = [...parsed.publication.fragments, ...parsed.publication.contributions].map(value => value.target);
        for (const target of targets) { assert.equal(labels.filter(label => label === target).length, 1, target); }
        const commands = [...result.latex.matchAll(/\\newcommand\{\\LitReference[A-Z]+\}[^\n]+/g)];
        assert.equal(commands.length, count);
        const destinations = commands.map(command => {
            const link = command[0].match(/\\hyperref\[(lit-[0-9a-f]+)\]/)!;
            assert.ok(link);
            assert.ok(command[0].includes(`\\pageref*{${link[1]}}`));
            return logicalTarget(link[1]);
        });
        assert.deepEqual(destinations, references(parsed.publication).map(ref => {
            assert.equal(ref.resolution.kind, 'resolved');
            return ref.resolution.kind === 'resolved' ? ref.resolution.target : assert.fail('unresolved');
        }));
    });
}
