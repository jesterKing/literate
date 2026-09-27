import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import hljs from 'highlight.js';
import type * as vscode from 'vscode';
import { generateProject, parseProject, PublicationModel, PublicationSegment, ParsedDocumentBlock } from '../../engine';
import { renderLatex } from '../../publication-latex';
import { renderScreenCode, renderScreenContribution, screenIndex } from '../../publication-screen';
import * as highlighter from '../../publication-highlight';
import { themes, themeCss } from '../../themes';
import { runPandoc } from '../../cli';
import { fixture, fence, tick } from './vscode-fixture';

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
    const found = [...html.matchAll(/<div class="codefragment">\s*<div class="fragmentname(?: code-line)?"[^>]*>([^]*?)<\/div>\s*<div class="code">([^]*?)<\/div>\s*(?:<nav[^]*?<\/nav>\s*)?<\/div>/g)];
    assert.equal(found.length, (html.match(/class="codefragment"/g) || []).length);
    return found.map(match => ({ label: textContent(match[1]).trim(), code: match[2] }));
}
function references(model: PublicationModel) {
    return model.contributions.flatMap(part => part.segments.filter(
            (segment): segment is Extract<PublicationSegment, { kind: 'reference' }> => segment.kind === 'reference'));
}
async function preview(inputs = documents(), f = fixture()) {
    for (const doc of inputs) { f.workspace.textDocuments.push(f.document(doc.path, doc.text)); }
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
    md.core.ruler.push('host_source_map', state => {
        for (const token of state.tokens) {
            if (token.map && token.type !== 'inline') {
                token.attrSet('data-line', String(token.map[0]));
                token.attrJoin('class', 'code-line');
            }
        }
    });
    const repository = subscriptions.find(value => value instanceof f.extension.FragmentRepository) as
        InstanceType<typeof f.extension.FragmentRepository>;
    for (const doc of inputs.length ? inputs : documents()) {
        md.render(doc.text, { currentDocument: f.document(doc.path, doc.text).uri });
    }
    await tick();
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    return { md, delegated, f, repository, dispose: () => subscriptions.forEach(value => value.dispose()) };
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
        assert.doesNotMatch(block.code, /onclick=|javascript:/);
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
        const p = await preview(inputs);
        try {
            for (const doc of parsed.documents) {
                p.delegated.length = 0;
                const env = { currentDocument: p.f.document(doc.path, doc.source).uri } as { currentDocument: vscode.Uri; gstate: { tokens: Token[] } };
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
                assert.match(html + screen, /\bid="[fc]-/);
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
test('only semantic references become links', async () => {
    const inputs = documents(), generated = generateProject(inputs), p = await preview(inputs);
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const outputs = [generated.files.find(file => file.path === 'index.html')!.content,
            p.md.render(source.text, { currentDocument: p.f.document(source.path, source.text).uri })];
        for (const html of outputs) {
            const tags = [...blocks(html)[0].code.matchAll(/<a class="literate-tag-name"[^>]*>([^]*?)<\/a>/g)];
            assert.deepEqual(tags.map(match => textContent(match[1])),
                ['<<a/b>>', '<<a-b>>', '<<a/b>>']);
            assert.ok(html.includes(escape('<<ordinary>>')));
            assert.ok(!tags.some(match => match[1].includes('ordinary')));
            assert.equal((blocks(html)[0].code.match(/<a\b/g) || []).length, 3);
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
    const inputs = highlightedDocuments(spaced), generated = generateProject(inputs), p = await preview(inputs);
    try {
        assert.deepEqual(generated.diagnostics, []);
        const env = {} as { gstate: { tokens: Token[] } };
        const screen = p.md.render(inputs[0].text, env);
        for (const html of [generated.files[0].content, screen]) {
            const code = blocks(html)[0].code;
            assert.match(code, /class="hljs-keyword"/);
            assert.match(code, /class="hljs-string"/);
            assert.doesNotMatch(code, /quiet comment/);
            assert.ok(code.includes(escape('<a href=x>')));
            assert.equal((code.match(/<a\b/g) || []).length, 1);
            const tags = [...code.matchAll(/<a class="literate-tag-name"[^>]*>([^]*?)<\/a>/g)];
            assert.deepEqual(tags.map(match => textContent(match[1])), ['<<a/b>>']);
        }
        assert.deepEqual(references(generated.publication).map(ref => ref.name), ['a/b']);
        assert.equal(p.delegated[0].token.info, 'js');
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
const familyA = 'f-0061002f0062';
const baseA = 'c-0061002f0062-0064006500660073002e006c0069007400650072006100740065-1';
const secondA = 'c-0061002f0062-0064006500660073002e006c0069007400650072006100740065-2';
const thirdA = 'c-0061002f0062-006d006f00720065002e006c0069007400650072006100740065-1';
for (const prefix of ['', 'Extra prose.\n\n']) {
    test(`static screen destinations and keyboard labels (${prefix.length})`, async () => {
        const inputs = documents(prefix), p = await preview(inputs);
        try {
            const generated = generateProject(inputs);
            for (const format of ['html', 'preview'] as const) {
                const pages = new Map(inputs.map(doc => [doc.path, format === 'html'
                    ? generated.files.find(file => file.path === doc.path.replace('.literate', '.html'))!.content
                    : p.md.render(doc.text, { currentDocument: p.f.document(doc.path, doc.text).uri })]));
                assert.ok(pages.get('defs.literate')!.includes(`href="#${secondA}"`));
                if (format === 'html') {
                    assert.ok(pages.get('index.literate')!.includes(`href="./defs.html#${familyA}"`));
                    assert.ok(pages.get('defs.literate')!.includes(`href="./more.html#${thirdA}"`));
                    assert.ok(pages.get('more.literate')!.includes(`href="./defs.html#${baseA}"`));
                } else {
                    for (const page of pages.values()) { assert.doesNotMatch(page, /#L\d+/); }
                    assert.match(pages.get('index.literate')!, /href="vscode:\/\/jesterking\.literate\/navigate\/[a-f0-9]{48}\/[a-f0-9]{48}\?windowId%3D1"/);
                }
                for (const label of ['Previous', 'Base', 'Next']) {
                    assert.ok([...pages.values()].some(html => html.includes(`aria-label="${label} contribution of a/b"`)));
                }
                for (const [path, html] of pages) {
                    assert.doesNotMatch(html, /onclick=|tabindex="-1"/);
                    for (const link of html.matchAll(/<a class="literate-tag-name" href="([^"]+)" data-literate-target="([^"]+)" aria-label="([^"]+)"/g)) {
                        assert.ok(link[3].length > 4);
                        const [file, locator] = link[1].split('#');
                        const target = link[2];
                        const part = generated.publication.contributions.find(value => value.target === target
                            || generated.publication.fragments.find(family => family.target === target)?.contributions[0] === value.target)!;
                        const destination = format === 'preview' && file ? part.definition.path
                            : file ? file.replace('./', '').replace(/\.html$/, '.literate') : path;
                        assert.equal((pages.get(destination)!.match(new RegExp(`id="${target}"`, 'g')) || []).length, 1);
                        if (format === 'preview' && file) {
                            assert.match(file, /^vscode:\/\/jesterking\.literate\/navigate\//);
                        } else { assert.equal(locator, target); }
                        if (format === 'preview') {
                            assert.match(pages.get(destination)!, new RegExp(`<[^>]*(?:class="[^"]*code-line"[^>]*id="${target}"|id="${target}"[^>]*class="code-line")[^>]*data-line="\\d+"`));
                        }
                    }
                }
            }
        } finally { p.dispose(); }
    });
}
test('nested chapters encode relative filenames and preserve whole-block syntax', async () => {
    const inputs = [
        { path: 'index.literate', text: '' },
        { path: 'nested/use.literate', text: fence('js: <<main>>=', 'const s = `before\n<<a/b>>\nafter`;\n\\<<a/b>>') },
        { path: 'defs/a #%.literate', text: fence('text: <<a/b>>=', 'value') }
    ];
    const p = await preview(inputs);
    try {
        const generated = generateProject(inputs);
        assert.deepEqual(generated.diagnostics, []);
        for (const format of ['html', 'preview'] as const) {
            const html = format === 'html' ? generated.files.find(file => file.path === 'nested/use.html')!.content
                : p.md.render(inputs[1].text, { currentDocument: p.f.document(inputs[1].path, inputs[1].text).uri });
            const code = blocks(html)[0].code;
            if (format === 'html') { assert.ok(code.includes(`href="./../defs/a%20%23%25.html#${familyA}"`)); }
            else { assert.match(code, /href="vscode:\/\/jesterking\.literate\/navigate\//); }
            assert.equal((code.match(/<a /g) || []).length, 1);
            assert.match(code, /class="hljs-string">\nafter`/);
        }
    } finally { p.dispose(); }
});
test('cached preview tokens use unsaved project buffers without I/O or generation', async () => {
    const inputs = documents(), p = await preview(inputs);
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const env = { currentDocument: p.f.document(source.path, source.text).uri };
        const tokens = p.md.parse(source.text, {});
        const before = JSON.stringify(tokens), reads = p.f.reads.length, writes = p.f.writes.length;
        const render = () => p.md.renderer.render(tokens, p.md.options, env);
        assert.match(render(), /href="vscode:\/\/jesterking\.literate\/navigate\//);
        p.f.open('defs.literate', '');
        assert.doesNotMatch(blocks(render())[0].code, /<a /);
        p.f.open('new.literate', fence('text: <<a/b>>=', 'new unsaved base'));
        assert.match(render(), /href="vscode:\/\/jesterking\.literate\/navigate\//);
        assert.equal(JSON.stringify(tokens), before);
        assert.equal(p.f.reads.length, reads);
        assert.equal(p.f.writes.length, writes);
    } finally { p.dispose(); }
});
test('current rendered source and missing metadata never borrow stale reference spans', async () => {
    const inputs = documents(), p = await preview(inputs);
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const env = { currentDocument: p.f.document(source.path, source.text).uri };
        const current = source.text.replace('before', 'UNSAVED before');
        assert.ok(blocks(p.md.render(current, env))[0].code.includes('UNSAVED before'));
        const tokens = new MarkdownIt().parse(current, {});
        const fragment = tokens.find(token => token.info.includes('main.*'))!;
        fragment.content = 'literal changed content\n';
        const screen = p.md.renderer.render(tokens, p.md.options, env);
        assert.ok(screen.includes('literal changed content'));
        assert.doesNotMatch(blocks(screen)[0].code, /<a /);
    } finally { p.dispose(); }
});
test('semantic links retain every palette and native keyboard focus styling', async () => {
    const p = await preview([]);
    try {
        for (const theme of themes) {
            const text = fence('SETTINGS', 'theme=' + theme.name) + highlightedDocuments()[0].text;
            p.f.open('index.literate', text);
            const html = generateProject([{ path: 'index.literate', text }]).files[0].content;
            const screen = p.md.render(text, { currentDocument: p.f.document('index.literate', text).uri });
            for (const output of [html, screen]) {
                assert.ok(output.includes(`data-literate-theme="${theme.name}"`));
                assert.ok(blocks(output)[0].code.includes(`href="#${familyA}"`));
                assert.match(blocks(output)[0].code, /class="hljs-string"/);
            }
            assert.match(themeCss(theme), /a:focus-visible \{ outline: 2px solid/);
        }
    } finally { p.dispose(); }
});
test('remote discovered snapshots refresh changed destinations without output writes', async () => {
    const f = fixture('vscode-remote://ssh-remote+host/project');
    for (const doc of documents()) { f.put(doc.path, doc.text); }
    const p = await preview([], f);
    try {
        const source = documents().find(doc => doc.path === 'index.literate')!;
        const tokens = p.md.parse(source.text, {});
        const env = { currentDocument: f.document(source.path, source.text).uri };
        const render = () => p.md.renderer.render(tokens, p.md.options, env);
        const writes = f.writes.length, commands = f.executedCommands.length;
        assert.match(render(), /href="vscode:\/\/jesterking\.literate\/navigate\//);
        f.put('defs.literate', '');
        await p.repository.processLiterateFiles(f.folder as unknown as vscode.WorkspaceFolder);
        assert.doesNotMatch(blocks(render())[0].code, /<a /);
        assert.equal(f.executedCommands.length, commands + 1);
        await p.repository.processLiterateFiles(f.folder as unknown as vscode.WorkspaceFolder);
        assert.equal(f.executedCommands.length, commands + 1);
        assert.equal(f.writes.length, writes);
    } finally { p.dispose(); }
});
test('invalid source and rejected declarations do not invent preview targets', async () => {
    const p = await preview([]);
    try {
        const valid = fence('text: <<a/b>>=', 'first');
        const nul = p.md.render(valid + '\u0000');
        assert.doesNotMatch(nul, /data-literate-target=|id="[fc]-/);
        const html = p.md.render(valid + fence('text: <<a/b>>=', '<<a/b>>')
            + fence('text: <<orphan>>=+', '<<a/b>>'));
        assert.equal((html.match(/id="f-/g) || []).length, 1);
        assert.equal((html.match(/id="c-/g) || []).length, 1);
        assert.doesNotMatch(blocks(html)[1].code + blocks(html)[2].code, /<a /);
    } finally { p.dispose(); }
});
test('uncached tokens require the complete declaration header', async () => {
    const inputs = documents(), p = await preview(inputs);
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const env = { currentDocument: p.f.document(source.path, source.text).uri };
        const tokens = new MarkdownIt().parse(source.text, {});
        assert.match(blocks(p.md.renderer.render(tokens, p.md.options, env))[0].code, /<a /);
        tokens.find(token => token.info.includes('main.*'))!.info += '; invalid-setting';
        const html = p.md.renderer.render(tokens, p.md.options, env);
        assert.doesNotMatch(html, /data-literate-target=|id="[fc]-/);
    } finally { p.dispose(); }
});
test('rendered root source controls theme and empty cached source', async () => {
    const p = await preview(highlightedDocuments());
    try {
        const text = fence('SETTINGS', 'theme=' + themes[0].name) + highlightedDocuments()[0].text;
        const env = { currentDocument: p.f.document('index.literate', text).uri };
        const html = p.md.render(text, env);
        assert.ok(html.includes(`data-literate-theme="${themes[0].name}"`));
        assert.ok(html.includes(`href="#${familyA}"`));
        const empty = p.md.parse('', {});
        assert.doesNotMatch(p.md.renderer.render(empty, p.md.options, env), /codefragment|data-literate-target=/);
    } finally { p.dispose(); }
});
test('currentDocument isolates workspaces and non-index chapter paths', async () => {
    const p = await preview(documents());
    try {
        const other = p.f.other;
        p.f.workspace.workspaceFolders.push(other);
        const source = fence('text: <<caller>>=', '<<a/b>>');
        const doc = p.f.document('nested/chapter.literate', source, other);
        p.f.workspace.textDocuments.push(doc);
        assert.doesNotMatch(blocks(p.md.render(source, { currentDocument: doc.uri }))[0].code, /<a /);
        p.f.workspace.textDocuments.push(p.f.document('base.literate', fence('text: <<a/b>>=', 'other'), other));
        p.md.render(source, { currentDocument: doc.uri });
        await tick(); await tick();
        const html = p.md.render(source, { currentDocument: doc.uri });
        assert.match(html, /href="vscode:\/\/jesterking\.literate\/navigate\//);
        assert.doesNotMatch(html, /href="[^"#]*defs\.literate/);
    } finally { p.dispose(); }
});
for (const [alias, language, body] of [
    ['jsonc', 'json', '{"value": "before <<a/b>> after"}'],
    ['json5', 'json', '{"value": "before <<a/b>> after"}'],
    ['tsx', 'jsx', 'const value = "before <<a/b>> after";'],
    ['typescriptreact', 'jsx', 'const value = "before <<a/b>> after";'],
    ['py3', 'python', 'value = "before <<a/b>> after"']
]) {
    test(`preview semantic highlighting retains host alias ${alias}`, async () => {
        const text = fence(`${alias} : <<main>>=`, body) + fence('text: <<a/b>>=', 'value');
        const p = await preview([{ path: 'index.literate', text }]);
        try {
            const html = blocks(p.md.render(text))[0].code;
            const expected = hljs.highlight(body, { language, ignoreIllegals: true }).value;
            assert.match(expected, /hljs-string/);
            assert.match(html, /hljs-string/);
            assert.match(html, /class="hljs-string"> after/);
            assert.equal((html.match(/<a /g) || []).length, 1);
            assert.equal(textContent(html).trim(), body);
        } finally { p.dispose(); }
    });
}
test('semantic screen merge and snapshot lookups scale linearly', () => {
    const original = highlighter.highlightContribution;
    const reads: number[] = [];
    try {
        for (const count of [1000, 2000, 4000]) {
            let visits = 0, leaves = 0;
            Object.assign(highlighter, { highlightContribution: (...args: Parameters<typeof original>) => {
                const display = original(...args);
                leaves = display.spans.length;
                display.spans = new Proxy(display.spans, { get(target, key, receiver) {
                    if (typeof key === 'string' && /^\d+$/.test(key)) { visits++; }
                    return Reflect.get(target, key, receiver);
                } });
                return display;
            } });
            const text = fence('js: <<main>>=', 'const s = "<<a/b>>";\n'.repeat(count))
                + fence('text: <<a/b>>=', 'base') + fence('text: <<a/b>>=+', 'addition');
            const model = parseProject([{ path: 'index.literate', text }]).publication;
            const lookup = screenIndex(model), part = model.contributions[0];
            const fail = () => assert.fail('linear model lookup during rendering');
            model.fragments.find = fail;
            model.contributions.find = fail;
            for (const family of model.fragments) { family.contributions.indexOf = fail; }
            const html = renderScreenCode(part, model, 'preview');
            assert.equal((html.match(/<a /g) || []).length, count);
            for (const contribution of model.contributions) {
                renderScreenContribution(contribution, model, 'preview', 'label', 'code');
            }
            assert.equal(screenIndex(model), lookup);
            assert.ok(visits <= 4 * (leaves + count), `${visits} reads for ${leaves} leaves and ${count} uses`);
            reads.push(visits);
        }
        assert.ok(reads[1] <= reads[0] * 2.1);
        assert.ok(reads[2] <= reads[1] * 2.1);
    } finally { Object.assign(highlighter, { highlightContribution: original }); }
});
test('cross-file capabilities select fresh unsaved declarations in the canonical document', async () => {
    const inputs = documents(), p = await preview(inputs);
    try {
        const source = inputs.find(doc => doc.path === 'index.literate')!;
        const env = { currentDocument: p.f.document(source.path, source.text).uri };
        const tokens = p.md.parse(source.text, {});
        const render = () => p.md.renderer.render(tokens, p.md.options, env);
        const href = render().match(new RegExp(`href="([^"]+)" data-literate-target="${familyA}"`))![1];
        for (const doc of inputs) { p.f.put(doc.path, doc.text); }
        await p.f.navigate(href);
        assert.equal(p.f.opened[0].selection.start.line, 4);
        const changed = p.f.open('defs.literate', 'New prose\n\n' + inputs.find(doc => doc.path === 'defs.literate')!.text);
        await p.f.navigate(href);
        assert.equal(p.f.opened[1].document, changed);
        assert.equal(p.f.opened[1].selection.start.line, 6);
        assert.ok(render().includes(`href="${href}" data-literate-target="${familyA}"`));
    } finally { p.dispose(); }
});
function capabilityHref(html: string, target = familyA): string {
    const match = html.match(new RegExp(`href="([^"]+)" data-literate-target="${target}"`));
    assert.ok(match, 'accepted target has a resolved capability');
    return match[1];
}
async function navigationFixture() {
    const p = await preview();
    for (const doc of documents()) { p.f.put(doc.path, doc.text); }
    const source = documents().find(doc => doc.path === 'index.literate')!;
    const render = () => p.md.render(source.text, { currentDocument: p.f.document(source.path, source.text).uri });
    return { ...p, render, href: capabilityHref(render()) };
}
test('capability handler accepts no caller-supplied navigation target', async () => {
    const p = await navigationFixture();
    try {
        const raw = p.href.split('?')[0];
        for (const href of [raw.replace('vscode:', 'command:'), raw.replace('jesterking.literate', 'other.extension'),
            raw + '/extra', raw + '#L1', raw.replace('/navigate/', '/open/'),
            raw.replace(/navigate\/[a-f0-9]{48}/, 'navigate/' + '0'.repeat(48)),
            raw.slice(0, -48) + '0'.repeat(48), 'vscode://jesterking.literate/navigate/../../secret']) {
            await p.f.navigate(href);
        }
        assert.equal(p.f.opened.length, 0);
        await p.f.navigate(raw + '?file=/other/secret&command=delete');
        assert.equal(p.f.opened.length, 1);
        assert.equal(p.f.opened[0].document.uri.toString(), p.f.uri('defs.literate'));
    } finally { p.dispose(); }
});
test('untrusted and removed workspaces fail closed without disabling local anchors', async () => {
    const p = await navigationFixture();
    try {
        p.f.workspace.isTrusted = false;
        assert.doesNotMatch(blocks(p.render())[0].code, /<a /);
        await p.f.navigate(p.href);
        const local = highlightedDocuments()[0];
        assert.ok(p.md.render(local.text, { currentDocument: p.f.document(local.path, local.text).uri }).includes(`href="#${familyA}"`));
        assert.equal(p.f.opened.length, 0);
        p.f.workspace.isTrusted = true;
        p.f.workspace.workspaceFolders = [];
        p.f.workspaceChanged();
        p.f.workspace.workspaceFolders = [p.f.folder];
        await p.f.navigate(p.href);
        assert.equal(p.f.opened.length, 0);
    } finally { p.dispose(); }
});
for (const failure of ['empty', 'deleted', 'symlink', 'directory', 'renamed']) {
    test(`stale capability fails closed for ${failure} destination`, async () => {
        const p = await navigationFixture();
        try {
            const writes = p.f.writes.length;
            if (failure === 'empty') { p.f.open('defs.literate', ''); }
            if (failure === 'deleted') { p.f.disk.delete(p.f.uri('defs.literate')); }
            if (failure === 'symlink') { p.f.types.set(p.f.uri('defs.literate'), 65); }
            if (failure === 'directory') { p.f.types.set(p.f.uri('defs.literate'), 2); }
            if (failure === 'renamed') { p.f.open('defs.literate', fence('text: <<renamed>>=', 'other')); }
            await p.f.navigate(p.href);
            assert.equal(p.f.opened.length, 0);
            assert.equal(p.f.writes.length, writes);
        } finally { p.dispose(); }
    });
}
test('navigation rechecks buffers and trust after asynchronous document opening', async () => {
    const p = await navigationFixture();
    try {
        p.f.controls.beforeOpen = () => { p.f.open('defs.literate', '\n\n' + documents()[1].text); };
        await p.f.navigate(p.href);
        assert.equal(p.f.opened[0].selection.start.line, 6);
        p.f.controls.beforeOpen = () => { p.f.workspace.isTrusted = false; };
        await p.f.navigate(p.href);
        assert.equal(p.f.opened.length, 1);
    } finally { p.dispose(); }
});
test('pending and failed external URLs stay unlinked without refresh loops', async () => {
    const f = fixture(), waiting: (() => void)[] = [];
    f.controls.externalUri = uri => new Promise(resolve => waiting.push(() => resolve(f.mock.Uri.parse(uri.toString() + '?opaque%3Dyes&windowId%3D7'))));
    const p = await preview(documents(), f);
    try {
        const source = documents()[2], env = { currentDocument: f.document(source.path, source.text).uri };
        for (let i = 0; i < 5; i++) { assert.doesNotMatch(blocks(p.md.render(source.text, env))[0].code, /<a |#L\d+/); }
        for (let i = 0; i < 5; i++) { waiting.splice(0).forEach(resolve => resolve()); await tick(); }
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        const ready = p.md.render(source.text, env), count = f.externalUris.length;
        assert.match(ready, /\?opaque%3Dyes&amp;windowId%3D7/);
        for (let i = 0; i < 5; i++) { p.md.render(source.text, env); await tick(); }
        assert.equal(f.externalUris.length, count);
        f.controls.externalUri = async () => { throw new Error('routing unavailable'); };
        f.open('fresh.literate', fence('text: <<fresh>>=', 'value'));
        const caller = fence('text: <<main.*>>= result.txt $', '<<fresh>>');
        p.md.render(caller, env); await tick();
        const failedCount = f.externalUris.length, refreshCount = f.executedCommands.length;
        assert.equal(failedCount, count + 1);
        for (let i = 0; i < 5; i++) { assert.doesNotMatch(blocks(p.md.render(caller, env))[0].code, /<a /); await tick(); }
        assert.equal(f.externalUris.length, failedCount);
        assert.equal(f.executedCommands.length, refreshCount);

    } finally { p.dispose(); }
});
test('capabilities expire on disposal and late resolver completion is inert', async () => {
    const old = await navigationFixture(), href = old.href;
    old.dispose();
    const next = await navigationFixture();
    try { await next.f.navigate(href); assert.equal(next.f.opened.length, 0); }
    finally { next.dispose(); }
    const f = fixture(), waiting: (() => void)[] = [];
    f.controls.externalUri = uri => new Promise(resolve => waiting.push(() => resolve(uri)));
    const p = await preview(documents(), f), before = f.executedCommands.length;
    p.dispose(); waiting.forEach(resolve => resolve()); await tick(); await tick();
    assert.equal(f.executedCommands.length, before);
});
test('capability budget bounds resolution and retention without remint loops', async () => {
    const uses = Array.from({ length: 4200 }, (_, i) => `<<part${i}>>`).join('\n');
    const definitions = Array.from({ length: 4200 }, (_, i) => fence(`text: <<part${i}>>=`, 'value')).join('\n');
    const inputs = [{ path: 'index.literate', text: fence('text: <<caller>>=', uses) },
        { path: 'defs.literate', text: definitions }];
    const p = await preview(inputs);
    try {
        await tick();
        assert.equal(p.f.externalUris.length, 4096);
        p.md.render(inputs[0].text, { currentDocument: p.f.document(inputs[0].path, inputs[0].text).uri });
        await tick();
        assert.equal(p.f.externalUris.length, 4096);
    } finally { p.dispose(); }
});
test('cross-document labels and Previous/Base/Next controls select accepted contributions', async () => {
    const p = await navigationFixture();
    try {
        for (const [name, target, line, destination] of [
            ['defs.literate', thirdA, 2, 'more.literate'],
            ['more.literate', familyA, 4, 'defs.literate'],
            ['more.literate', baseA, 4, 'defs.literate'],
            ['more.literate', secondA, 10, 'defs.literate']
        ] as const) {
            const doc = documents().find(value => value.path === name)!;
            const html = p.md.render(doc.text, { currentDocument: p.f.document(doc.path, doc.text).uri });
            await p.f.navigate(capabilityHref(html, target));
            const opened = p.f.opened[p.f.opened.length - 1];
            assert.equal(opened.document.uri.toString(), p.f.uri(destination));
            assert.equal(opened.selection.start.line, line);
        }
    } finally { p.dispose(); }
});
test('capabilities retain workspace identity and untrusted activation mints none', async () => {
    const p = await navigationFixture();
    try {
        p.f.workspace.workspaceFolders.push(p.f.other);
        for (const doc of documents()) { p.f.open(doc.path, doc.text, p.f.other); p.f.put(doc.path, doc.text, p.f.other); }
        const source = documents()[2], env = { currentDocument: p.f.document(source.path, source.text, p.f.other).uri };
        p.md.render(source.text, env); await tick(); await tick();
        const href = capabilityHref(p.md.render(source.text, env));
        assert.notEqual(href, p.href);
        await p.f.navigate(href); await p.f.navigate(p.href);
        assert.equal(p.f.opened[0].document.uri.toString(), p.f.uri('defs.literate', p.f.other));
        assert.equal(p.f.opened[1].document.uri.toString(), p.f.uri('defs.literate'));
    } finally { p.dispose(); }
    const f = fixture(); f.workspace.isTrusted = false;
    const restricted = await preview(documents(), f);
    try { assert.equal(f.externalUris.length, 0); }
    finally { restricted.dispose(); }
});
test('re-added workspace remints working links without reviving removed capabilities', async () => {
    const p = await navigationFixture();
    try {
        p.f.workspace.workspaceFolders = [];
        p.f.workspaceChanged();
        p.f.workspace.workspaceFolders = [p.f.folder];
        assert.doesNotMatch(blocks(p.render())[0].code, /<a /);
        await tick(); await tick();
        const href = capabilityHref(p.render());
        assert.notEqual(href, p.href);
        await p.f.navigate(p.href);
        assert.equal(p.f.opened.length, 0);
        await p.f.navigate(href);
        assert.equal(p.f.opened.length, 1);
        assert.equal(p.f.opened[0].document.uri.toString(), p.f.uri('defs.literate'));
    } finally { p.dispose(); }
});
for (const retained of [false, true]) {
    test(`discarding another input while opening cannot preserve a stale target (${retained})`, async () => {
        const inputs = [{ path: 'index.literate', text: fence('text: <<caller>>=', '<<a/b>>') },
            { path: 'a.literate', text: '' }, { path: 'b.literate', text: fence('text: <<a/b>>=', 'duplicate') }];
        const p = await preview(inputs);
        try {
            for (const doc of inputs) { p.f.put(doc.path, doc.text); }
            p.f.put('a.literate', fence('text: <<a/b>>=', 'saved first definition'));
            const html = p.md.render(inputs[0].text, { currentDocument: p.f.document('index.literate', inputs[0].text).uri });
            p.f.controls.beforeOpen = () => {
                const a = p.f.docs.find(doc => doc.uri.toString() === p.f.uri('a.literate'))!;
                Object.assign(a, { isClosed: true });
                if (!retained) { p.f.workspace.textDocuments = p.f.docs.filter(doc => doc !== a); }
            };
            await p.f.navigate(capabilityHref(html));
            assert.equal(p.f.opened.length, 0, 'the no-longer-accepted duplicate must not be shown');
        } finally { p.dispose(); }
    });
}
async function clockedPreview(context: { mock: { timers: unknown } }, f = fixture()) {
    const timers = context.mock.timers as unknown as {
        enable(options: { apis: string[] }): void; tick(milliseconds: number): void; runAll(): void; reset(): void;
    };
    timers.enable({ apis: ['Date', 'setTimeout'] });
    let settled = false;
    const pending = preview(documents(), f).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 200 && !settled; attempt++) { await tick(); timers.tick(5); }
    assert.ok(settled, 'activation finishes under the virtual clock');
    const p = await pending, source = documents()[2];
    const render = () => p.md.render(source.text, { currentDocument: f.document(source.path, source.text).uri });
    return { ...p, timers, render };
}
test('external URLs expire and renew opaquely without reminting or render loops', async context => {
    const p = await clockedPreview(context), waiting: (() => void)[] = [];
    try {
        const old = capabilityHref(p.render()), count = p.f.externalUris.length;
        const refreshes = p.f.executedCommands.length;
        p.f.controls.externalUri = uri => new Promise(resolve => waiting.push(() =>
            resolve(p.f.mock.Uri.parse(uri.toString() + '?opaque%3Drenewed&windowId%3D9'))));
        p.timers.tick(60_000); p.timers.tick(0);
        assert.equal(p.f.externalUris.length, count);
        assert.equal(p.f.executedCommands.length, refreshes + 1);
        for (let i = 0; i < 5; i++) { assert.doesNotMatch(blocks(p.render())[0].code, /<a |#L\d+/); }
        for (let i = 0; i < 5; i++) { waiting.splice(0).forEach(resolve => resolve()); await tick(); }
        p.timers.tick(0);
        assert.equal(p.f.externalUris.length, count + 2);
        assert.equal(capabilityHref(p.render()), old.split('?')[0] + '?opaque%3Drenewed&amp;windowId%3D9');
        const readyRefreshes = p.f.executedCommands.length;
        for (let i = 0; i < 5; i++) { p.render(); await tick(); p.timers.tick(0); }
        assert.equal(p.f.externalUris.length, count + 2);
        assert.equal(p.f.executedCommands.length, readyRefreshes);
    } finally { p.dispose(); p.timers.reset(); }
});
test('failed URL renewal retries only on demand after its cooldown', async context => {
    const p = await clockedPreview(context);
    try {
        const old = capabilityHref(p.render());
        p.timers.tick(60_000); p.timers.tick(0);
        p.f.controls.externalUri = async () => { throw new Error('external route invalidated'); };
        p.render(); await tick(); p.timers.tick(0);
        const count = p.f.externalUris.length, refreshes = p.f.executedCommands.length;
        for (let i = 0; i < 5; i++) { assert.doesNotMatch(blocks(p.render())[0].code, /<a /); await tick(); }
        p.timers.tick(59_999); p.render(); await tick();
        assert.equal(p.f.externalUris.length, count);
        assert.equal(p.f.executedCommands.length, refreshes);
        p.timers.tick(1);
        assert.equal(p.f.externalUris.length, count, 'elapsed time alone does not retry failures');
        p.f.controls.externalUri = async uri => p.f.mock.Uri.parse(uri.toString() + '?recovered%3Dyes');
        p.render(); await tick(); p.timers.tick(0);
        assert.equal(p.f.externalUris.length, count + 2);
        assert.equal(capabilityHref(p.render()), old.split('?')[0] + '?recovered%3Dyes');
    } finally { p.dispose(); p.timers.reset(); }
});
for (const action of ['idle', 'remove', 'dispose']) {
    test(`URL renewal lifecycle remains inert after ${action}`, async context => {
        const p = await clockedPreview(context), waiting: (() => void)[] = [];
        try {
            p.timers.tick(60_000); p.timers.tick(0);
            if (action !== 'idle') {
                p.f.controls.externalUri = uri => new Promise(resolve => waiting.push(() => resolve(uri)));
                p.render();
                if (action === 'remove') { p.f.workspace.workspaceFolders = []; p.f.workspaceChanged(); }
                else { p.dispose(); }
            }
            const count = p.f.externalUris.length, refreshes = p.f.executedCommands.length;
            waiting.forEach(resolve => resolve()); await tick();
            p.timers.tick(600_000); p.timers.tick(0);
            assert.equal(p.f.externalUris.length, count);
            assert.equal(p.f.executedCommands.length, refreshes);
        } finally { p.dispose(); p.timers.reset(); }
    });
}
for (const action of ['remove', 'dispose']) {
    test(`live external URL expiry timer is cancelled on ${action}`, async context => {
        const p = await clockedPreview(context);
        try {
            const now = Date.now(), refreshes = p.f.executedCommands.length;
            if (action === 'remove') { p.f.workspace.workspaceFolders = []; p.f.workspaceChanged(); }
            else { p.dispose(); }
            p.timers.runAll();
            assert.equal(Date.now(), now, 'no expiry timer remains queued');
            assert.equal(p.f.executedCommands.length, refreshes);
        } finally { p.dispose(); p.timers.reset(); }
    });
}
