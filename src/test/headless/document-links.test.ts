import assert = require('node:assert/strict');
import { test } from 'node:test';
import MarkdownIt = require('markdown-it');
import { generateProject, hasErrors, parseProject } from '../../engine';
import { installScreenPublicationLinks } from '../../publication-screen';
import { renderLatex } from '../../publication-latex';

const documents = [
    { path: 'index.literate', text: '[source](chapter.literate#heading) [legacy](chapter.html#heading)\n'
        + '[external](https://example.org/chapter.html) [network](//example.org/chapter.html)\n'
        + '[asset](asset.html) [encoded](a%20b.html?view=1#heading)' },
    { path: 'chapter.literate', text: '# Heading\n' },
    { path: 'a b.literate', text: '# Heading\n' }
];

test('entry legacy source links warn without blocking generation and preserve suffixes', () => {
    const result = generateProject(documents);
    assert.equal(hasErrors(result.diagnostics), false);
    assert.equal(result.diagnostics.length, 2);
    assert.ok(result.diagnostics.every(diagnostic => diagnostic.severity === 'warning'
        && diagnostic.code === 'legacy-document-link' && diagnostic.path === 'index.literate'));
    assert.match(result.diagnostics[0].message, /chapter\.literate#heading/);
    assert.match(result.diagnostics[1].message, /a%20b\.literate\?view=1#heading/);
    const html = result.files.find(file => file.path === 'index.html')!.content;
    assert.match(html, /href="chapter.html#heading"/);
    assert.match(html, /href="asset.html"/);
    assert.match(html, /https:\/\/example.org\/chapter.html/);
    assert.equal(generateProject(documents.slice(1).concat({ path: 'other.literate',
        text: '[legacy](chapter.html)' })).diagnostics.length, 0);
    assert.equal(hasErrors([{ path: '', line: 0, column: 0, message: 'old error' }]), true);
});

test('ordinary preview source and legacy links resolve without mutating cached tokens', () => {
    const md = new MarkdownIt();
    installScreenPublicationLinks(md);
    const project = parseProject(documents);
    const tokens = md.parse('[old](chapter.html#heading) [source](chapter.literate#heading) [asset](asset.html)', {});
    const before = JSON.stringify(tokens);
    const html = md.renderer.render(tokens, md.options, { literateScreen: {
        format: 'preview', path: 'index.literate', model: project.publication, annotations: project.annotations
    } });
    assert.equal((html.match(/href="chapter.literate#heading"/g) || []).length, 2);
    assert.match(html, /href="asset.html"/);
    assert.equal(JSON.stringify(tokens), before);
});

test('publication retains warnings while producing LaTeX', async () => {
    const result = await renderLatex(parseProject([{ path: 'index.literate', text: '[chapter](chapter.html#heading)' }, documents[1]]), {
        theme: 'hermonica'
    }, async () => 'body');
    assert.ok(result.latex);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].severity, 'warning');
});
