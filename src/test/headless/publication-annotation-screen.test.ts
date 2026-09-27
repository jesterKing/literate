import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import type * as vscode from 'vscode';
import { generateProject, parseProject, PublicationModel } from '../../engine';
import type { PublicationAnnotations } from '../../publication-annotations';
import { renderScreenIndexes, screenIndex } from '../../publication-screen';
import { fixture, fence, tick } from './vscode-fixture';

const definition = fence('TERM alpha "Alpha & <title>"', 'Definition *emphasis*, **strong**, `code`.\n\n- first\n- [self](term:alpha)');
const note = fence('NOTE', 'Explanation, not a term. [Alpha](term:alpha).');
const inputs = () => [
    { path: 'index.literate', text: '# Book\n\n[Definitions](defs.html)\n\n[Alpha](term:alpha)\n\n' + note
        + fence('text: <<caller>>=', '<<piece>>') },
    { path: 'defs.literate', text: '# Definitions\n\n' + definition + fence('text: <<piece>>=', 'value') }
];
async function preview(documents = inputs()) {
    const f = fixture();
    for (const doc of documents) { f.put(doc.path, doc.text); }
    const subscriptions: vscode.Disposable[] = [];
    const api = await f.extension.activate({ subscriptions } as unknown as vscode.ExtensionContext);
    const md = new MarkdownIt({ html: true });
    api.extendMarkdownIt(md);
    md.core.ruler.push('host_source_map', state => {
        for (const token of state.tokens) {
            if (token.map && token.type !== 'inline') {
                token.attrSet('data-line', String(token.map[0]));
                token.attrJoin('class', 'code-line');
            }
        }
    });
    const render = (path: string, text: string) => md.render(text, { currentDocument: f.document(path, text).uri });
    for (const doc of documents) { render(doc.path, doc.text); }
    await tick();
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    const repository = subscriptions.find(value => value instanceof f.extension.FragmentRepository) as
        InstanceType<typeof f.extension.FragmentRepository>;
    return { f, md, render, repository, dispose: () => subscriptions.forEach(value => value.dispose()) };
}
function hrefFor(html: string, target: string): string {
    const tag = [...html.matchAll(/<a\b[^>]*>/g)].find(match => match[0].includes(`data-literate-target="${target}"`));
    assert.ok(tag, target);
    return tag[0].match(/href="([^"]+)"/)![1].replace(/&amp;/g, '&');
}

test('actual HTML and activated preview render annotation prose, indexes and accepted source maps', async () => {
    const docs = inputs(), parsed = parseProject(docs), generated = generateProject(docs);
    assert.deepEqual(generated.diagnostics, []);
    const p = await preview(docs);
    try {
        const term = parsed.annotations.terms[0], explanatory = parsed.annotations.notes[0];
        const lookup = screenIndex(parsed.publication, parsed.annotations);
        assert.deepEqual(lookup.targets.get(term.target)?.definition, term.at);
        assert.deepEqual(lookup.targets.get(explanatory.target)?.definition, explanatory.at);
        assert.equal(screenIndex(parsed.publication, parsed.annotations), lookup);
        for (const doc of docs) {
            const html = generated.files.find(file => file.path === doc.path.replace('.literate', '.html'))!.content;
            const screen = p.render(doc.path, doc.text);
            for (const output of [html, screen]) {
                assert.doesNotMatch(output, /href="term:|#L\d/);
                assert.equal(output.includes('<h2>Term index</h2>'), doc.path === 'index.literate');
                assert.equal(output.includes('<h2>Fragment index</h2>'), doc.path === 'index.literate');
                for (const part of parsed.publication.contributions.filter(value => value.definition.path === doc.path)) {
                    assert.ok(output.includes(`id="${part.target}"`));
                    assert.ok(output.includes(`id="${part.fragmentTarget}"`));
                }
            }
            const annotation = doc.path === 'index.literate' ? explanatory : term;
            assert.ok(screen.includes(`data-line="${annotation.at.line}" id="${annotation.target}"`));
            if (doc.path === 'defs.literate') {
                for (const output of [html, screen]) {
                    assert.match(output, /Alpha &amp; &lt;title&gt;/);
                    assert.match(output, /<em>emphasis<\/em>/);
                    assert.match(output, /<strong>strong<\/strong>/);
                    assert.match(output, /<code>code<\/code>/);
                    assert.match(output, /<ul>/);
                    assert.equal(hrefFor(output, term.target), '#' + term.target);
                }
            } else {
                assert.match(html, /<aside class="literate-annotation literate-note"/);
                assert.match(html, />Note 1<\/div>/);
                assert.equal(hrefFor(html, term.target), './defs.html#' + term.target);
                assert.match(hrefFor(screen, term.target), /^vscode:\/\/jesterking\.literate\/navigate\//);
                assert.match(html, />Reference 1<\/a>/);
                for (const target of [...html.matchAll(/href="#(annotation-use-[^"]+)"/g)]) {
                    assert.ok(html.includes(`id="${target[1]}"`), 'local reference index anchor exists');
                }
            }
        }
    } finally { p.dispose(); }
});

test('term capability re-resolves dirty canonical definitions and rejects missing or ambiguous targets', async () => {
    const docs = inputs(), p = await preview(docs);
    try {
        const target = parseProject(docs).annotations.terms[0].target;
        const href = hrefFor(p.render(docs[0].path, docs[0].text), target);
        const dirty = p.f.open('defs.literate', '\n\n\n' + docs[1].text);
        await p.f.navigate(href);
        assert.equal(p.f.opened.length, 1);
        assert.equal(p.f.opened[0].document, dirty);
        assert.equal(p.f.opened[0].selection.start.line, 5);
        assert.equal(p.f.opened[0].document.uri.fragment, '');
        p.f.open('defs.literate', 'Removed');
        assert.doesNotMatch(p.render(docs[0].path, docs[0].text), /href="term:|data-literate-target="annotation-term-/);
        await p.f.navigate(href);
        assert.equal(p.f.opened.length, 1);
        p.f.open('defs.literate', definition + definition);
        const ambiguous = p.render(docs[0].path, docs[0].text);
        assert.match(ambiguous, /<span class="literate-term-unresolved">Alpha<\/span>/);
        assert.doesNotMatch(ambiguous, /href="term:/);
        await p.f.navigate(href);
        assert.equal(p.f.opened.length, 1);
    } finally { p.dispose(); }
});

test('annotation bodies close XSS and unsupported Markdown while heading and body term links stay safe', async () => {
    const text = '# [Heading](term:alpha)\n\n' + definition + fence('NOTE',
        '<a href="javascript:alert(1)" data-literate-target="forged" onclick="alert(1)">raw</a>\n\n'
        + '![image](https://example.com/image.png)\n\n# not a heading\n\n'
        + '[missing](term:absent) [bad](javascript:alert(1)) [web](https://example.com/) [body](term:alpha) '
                + '[alias][a] <term:alpha>\n\n[a]: term:alpha');
    const p = await preview([{ path: 'index.literate', text }]);
    try {
        const html = p.render('index.literate', text);
        assert.doesNotMatch(html, /<img|<script|<a[^>]+(?:onclick|javascript:)|data-literate-target="forged"|href="term:/);
        assert.match(html, /&lt;a href=/);
        assert.match(html, /<span class="literate-term-unresolved">missing<\/span>/);
        assert.match(html, /href="https:\/\/example.com\/"/);
        assert.match(html, /<a href="#annotation-term-[^"]+"[^>]*>body<\/a>/);
        assert.match(html, /<h1[^>]*><span id="annotation-use-[^"]+" class="code-line" data-line="0"><\/span><a href="#annotation-term-[^"]+" data-literate-target="annotation-term-[^"]+">Heading<\/a><\/h1>/);
        assert.doesNotMatch(html, /<h1[^>]*>not a heading/);
        assert.match(html, /<a href="#annotation-term-[^"]+"[^>]*>alias<\/a>/);
        assert.match(html, /<a href="#annotation-term-[^"]+"[^>]*>term:alpha<\/a>/);
        const parsed = parseProject([{ path: 'index.literate', text }]);
        const targets = screenIndex(parsed.publication, parsed.annotations).targets;
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        for (const target of targets.keys()) {
            if (target.startsWith('annotation-use-')) { assert.equal(ids.filter(id => id === target).length, 1); }
        }
    } finally { p.dispose(); }
});

test('annotation-only snapshots invalidate preview once and cached previews overlay current buffers', async () => {
    const docs = inputs(), p = await preview(docs);
    try {
        const tokens = p.md.parse(docs[0].text, {}), before = JSON.stringify(tokens);
        const render = () => p.md.renderer.render(tokens, p.md.options, { currentDocument: p.f.document('index.literate', docs[0].text).uri });
        const count = () => p.f.executedCommands.filter(value => value === 'markdown.preview.refresh').length;
        const initial = count();
        p.f.put('defs.literate', docs[1].text.replace('Alpha & <title>', 'Changed title'));
        await p.repository.processLiterateFiles(p.f.folder as unknown as vscode.WorkspaceFolder);
        assert.equal(count(), initial + 1);
        await p.repository.processLiterateFiles(p.f.folder as unknown as vscode.WorkspaceFolder);
        assert.equal(count(), initial + 1);
        assert.match(render(), /Changed title/);
        p.f.open('defs.literate', docs[1].text.replace('Alpha & <title>', 'Dirty title'));
        const reads = p.f.reads.length, writes = p.f.writes.length;
        assert.match(render(), /Dirty title/);
        assert.equal(p.f.reads.length, reads);
        assert.equal(p.f.writes.length, writes);
        assert.equal(JSON.stringify(tokens), before);
    } finally { p.dispose(); }
});

test('body aliases and autolinks align with collected uses and every project index anchor', async () => {
    const body = '[Alias][a] and <term:alpha>.\n\n[a]: term:alpha';
    const docs = inputs();
    docs[0].text += fence('NOTE', body);
    docs[1].text = docs[1].text.replace(definition, fence('TERM alpha "Alpha"', body));
    const parsed = parseProject(docs), generated = generateProject(docs), p = await preview(docs);
    try {
        assert.deepEqual(generated.diagnostics, []);
        const annotations = [...parsed.annotations.terms, ...parsed.annotations.notes];
        for (const annotation of annotations.filter(value => value.body.includes('[Alias]'))) {
            const uses = parsed.annotations.uses.filter(use => use.owner === annotation.target);
            assert.equal(uses.length, 2, 'alias and autolink are both model occurrences');
            assert.ok(uses.every(use => use.resolution === 'resolved'));
            assert.notEqual(uses[0].childIndex, uses[1].childIndex);
        }
        for (const format of ['html', 'preview'] as const) {
            const pages = docs.map(doc => format === 'html'
                ? generated.files.find(file => file.path === doc.path.replace('.literate', '.html'))!.content
                : p.render(doc.path, doc.text));
            const all = pages.join('\n');
            assert.equal((all.match(/>Alias<\/a>/g) || []).length, 2);
            assert.equal((all.match(/>term:alpha<\/a>/g) || []).length, 2);
            assert.doesNotMatch(all, /href="term:|\[Alias\]\[a\]|\[a\]:/);
            const ids = [...all.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
            const lookup = screenIndex(parsed.publication, parsed.annotations);
            const uses = [...lookup.targets.keys()].filter(target => target.startsWith('annotation-use-'));
            assert.equal(uses.length, parsed.annotations.uses.length);
            for (const target of uses) {
                assert.equal(ids.filter(id => id === target).length, 1, target);
                assert.ok(hrefFor(pages[0], target), 'root index links every occurrence');
            }
            for (const link of pages[0].matchAll(/data-literate-target="([^"]+)"/g)) {
                assert.ok(ids.includes(link[1]), `project destination exists: ${link[1]}`);
            }
        }
    } finally { p.dispose(); }
});

test('cached index reverse references require linear reads and never rescan source arrays when rendering', () => {
    for (const size of [1000, 2000]) {
        let reads = 0;
        const counted = <T>(values: T[]) => new Proxy(values, { get(array, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) { reads++; }
            return Reflect.get(array, key, receiver);
        } });
        const at = { path: 'index.literate', line: 0, column: 0 };
        const model: PublicationModel = {
            documents: [{ path: at.path, contributions: [] }],
            fragments: Array.from({ length: size }, (_, i) => ({ name: `Family ${i}`, target: `f-${i}`, contributions: [`c-${i}`] })),
            contributions: counted(Array.from({ length: size }, (_, i) => ({
                target: `c-${i}`, fragmentTarget: `f-${i}`, kind: 'definition' as const,
                language: 'text', definition: at, tokenIndex: i, content: '',
                segments: [0, 1].map(() => ({ kind: 'reference' as const, text: '', name: `Family ${i}`,
                    start: 0, end: 0, at, resolution: { kind: 'resolved' as const, target: `f-${i}` } }))
            })))
        };
        const annotations: PublicationAnnotations = {
            terms: Array.from({ length: size }, (_, i) => ({ key: `t${i}`, title: `Term ${i}`,
                target: `t-${i}`, at, tokenIndex: i, body: '' })), notes: [], diagnostics: [],
            uses: counted(Array.from({ length: size }, (_, i) => ({ key: `t${i}`, target: `t-${i}`,
                at, owner: at.path, tokenIndex: i, childIndex: 0, resolution: 'resolved' as const })))
        };
        const lookup = screenIndex(model, annotations);
        assert.ok(reads <= 8 * size, `${reads} source reads for ${size} entries`);
        assert.equal(lookup.fragmentReferences.get('f-0')?.length, 1, 'duplicate family uses are deduplicated per contribution');
        assert.equal(lookup.termReferences.get('t-0')?.length, 1);
        reads = 0;
        for (let repeat = 0; repeat < 2; repeat++) {
            assert.equal(screenIndex(model, annotations), lookup);
            const html = renderScreenIndexes({ model, annotations, path: at.path, format: 'html' }, [at.path]);
            assert.equal((html.match(/>Reference 1<\/a>/g) || []).length, 2 * size);
            assert.equal(reads, 0, 'cached index rendering must not scan contributions or term uses');
        }
    }
});

test('legacy books have no indexes; without root index only first document owns global indexes', () => {
    const legacy = generateProject([{ path: 'index.literate', text: fence('text: <<plain>>=', 'text') }]);
    assert.doesNotMatch(legacy.files[0].content, /Term index|Fragment index|literate-annotation/);
    const docs = [{ path: 'b.literate', text: definition }, { path: 'a.literate', text: note }];
    const generated = generateProject(docs);
    assert.deepEqual(generated.diagnostics, []);
    assert.match(generated.files.find(file => file.path === 'a.html')!.content, /Term index/);
    assert.doesNotMatch(generated.files.find(file => file.path === 'b.html')!.content, /Term index/);
});
