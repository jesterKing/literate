import assert = require('node:assert/strict');
import { test } from 'node:test';
import hljs from 'highlight.js';
import { parseProject } from '../../engine';
import { themes, syntaxColor, themeCss } from '../../themes';
import { renderLatex } from '../../publication-latex';
import type { PandocBlock } from '../../publication-pandoc';
import { createHash } from 'node:crypto';
import { highlightContribution, syntaxStyle } from '../../publication-highlight';
const tag = (name: string) => '<' + '<' + name + '>>';
const publicationFence = (header: string, content: string) => '```' + header + '\n' + content + '\n```\n';
function part(body: string, language = 'javascript') {
    const result = parseProject([{ path: 'index.literate', text:
        publicationFence(language + ': ' + tag('main') + '=', body) +
        publicationFence(': ' + tag('piece') + '=', 'x') }]);
    assert.deepEqual(result.diagnostics, []);
    return result.publication.contributions[0];
}
function finalPart(body: string) {
    const result = parseProject([{ path: 'index.literate', text:
        publicationFence(': ' + tag('piece') + '=', 'x') +
        '```javascript: ' + tag('main') + '=\n' + body }]);
    assert.deepEqual(result.diagnostics, []);
    return result.publication.contributions[1];
}
function scopeAt(result: ReturnType<typeof highlightContribution>, marker: string): string {
    const offset = result.text.indexOf(marker);
    assert.ok(offset >= 0);
    return result.spans.find(span => span.start <= offset && offset < span.end)!.scope;
}
test('whole-block highlighting preserves template context around references', () => {
    const marker = 'TEMPLATE_AFTER';
    const result = highlightContribution(part('const message = `before\n' + tag('piece') +
        '\n' + marker + ' ${count + 1}`;'));
    assert.equal(scopeAt(result, marker), 'string');
    assert.equal(result.references.length, 1);
    const suffix = result.text.slice(result.references[0].end);
    assert.notEqual(scopeAt(highlightContribution(part(suffix)), marker), 'string');
    assert.equal(scopeAt(result, 'const'), 'keyword');
});

test('comment-only lines collapse while code and semantic references remain', () => {
    const comments = '  /* some comment\n   * in code\n   **/\nif (actual_code) {\n  do_stuff();\n}';
    assert.equal(highlightContribution(part(comments)).text,
        'if (actual_code) {\n  do_stuff();\n}\n');
    assert.equal(highlightContribution(part('const ready = true; // hidden')).text,
        'const ready = true; \n');
    const referenced = highlightContribution(part('/* before\n' + tag('piece') + '\nafter */\nconst ready = true;'));
    assert.equal(referenced.text, tag('piece') + '\nconst ready = true;\n');
    assert.equal(referenced.references.length, 1);
});
test('literal unescape maps repeated references after emoji in UTF-16', () => {
    const input = part('\\' + tag('literal') + ' 😀 ' + tag('piece') + '/' + tag('piece'), 'unknown-language');
    const snapshot = JSON.stringify(input);
    const result = highlightContribution(input);
    assert.equal(result.text, tag('literal') + ' 😀 ' + tag('piece') + '/' + tag('piece') + '\n');
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].start, tag('literal').length + 4);
    const source = input.segments.filter(
        (segment): segment is Extract<(typeof input.segments)[number], { kind: 'reference' }> =>
            segment.kind === 'reference');
    for (const [index, ref] of result.references.entries()) {
        assert.equal(result.text.slice(ref.start, ref.end), tag('piece'));
        assert.equal(ref.name, 'piece');
        assert.ok(ref.target);
        assert.equal(ref.occurrenceTarget, source[index].occurrenceTarget);
        assert.equal(ref.placement, source[index].placement);
        assert.equal(ref.annotation, source[index].annotation);
        assert.equal(ref.occurrenceTarget, `${input.target}-r-${index + 1}`);
    }
    assert.deepEqual(result.spans, [{ start: 0, end: result.text.length, scope: '' }]);
    assert.equal(JSON.stringify(input), snapshot);
});

test('reference occurrences distinguish placement and explicit rail annotations', () => {
    const input = part(' \t' + tag('piece') + '[rail] \t\n' +
        'prefix ' + tag('piece') + '\n' + tag('piece') + '[rail] suffix\n' +
        tag('piece') + ' ' + tag('piece') + '\n\\' + tag('literal') + ' ' + tag('piece'));
    const refs = input.segments.filter(
        (segment): segment is Extract<(typeof input.segments)[number], { kind: 'reference' }> =>
            segment.kind === 'reference');
    assert.deepEqual(refs.map(ref => ref.placement),
        ['standalone', 'inline', 'inline', 'inline', 'inline', 'inline']);
    assert.deepEqual(refs.map(ref => ref.annotation),
        ['rail', 'none', 'rail', 'none', 'none', 'none']);
    assert.doesNotMatch(highlightContribution(input).text, /\[rail\]/);
    assert.deepEqual(refs.map(ref => ref.occurrenceTarget),
        refs.map((_, index) => `${input.target}-r-${index + 1}`));
    const eof = finalPart('\t' + tag('piece') + '  ');
    const eofRef = eof.segments.find(
        (segment): segment is Extract<(typeof eof.segments)[number], { kind: 'reference' }> =>
            segment.kind === 'reference')!;
    assert.equal(eofRef.placement, 'standalone');
    assert.equal(eofRef.occurrenceTarget, `${eof.target}-r-1`);
    const occurrences = (value: typeof input) => value.segments.flatMap(segment =>
        segment.kind === 'reference' ? [segment.occurrenceTarget] : []);
    const before = part('ordinary text\n' + tag('piece'));
    const after = part('different ordinary text\n' + tag('piece'));
    assert.deepEqual(occurrences(before), occurrences(after));
});
test('standalone validation rejects missing references, modifiers and invalid segments', () => {
    assert.throws(() => highlightContribution(part(tag('missing'))), /target is missing/);
    assert.throws(() => highlightContribution(part(tag('piece') + '=+')), /modifier/);
    const input = part(tag('piece'));
    input.content += 'bad';
    assert.throws(() => highlightContribution(input), /reconstruct/);
    const invalid = part(tag('piece'));
    const ref = invalid.segments.find(segment => segment.kind === 'reference')!;
    if (ref.kind === 'reference') { ref.start++; }
    assert.throws(() => highlightContribution(invalid), /offsets/);
    const missingOccurrence = part(tag('piece'));
    const missingRef = missingOccurrence.segments.find(segment => segment.kind === 'reference')!;
    if (missingRef.kind === 'reference') { missingRef.occurrenceTarget = ''; }
    assert.throws(() => highlightContribution(missingOccurrence), /occurrence target/);
    const invalidPlacement = part(tag('piece'));
    const placementRef = invalidPlacement.segments.find(segment => segment.kind === 'reference')!;
    if (placementRef.kind === 'reference') {
        (placementRef as unknown as { placement: string }).placement = 'invalid';
    }
    assert.throws(() => highlightContribution(invalidPlacement), /placement/);
    const invalidAnnotation = part(tag('piece'));
    const annotationRef = invalidAnnotation.segments.find(segment => segment.kind === 'reference')!;
    if (annotationRef.kind === 'reference') {
        (annotationRef as unknown as { annotation: string }).annotation = 'invalid';
    }
    assert.throws(() => highlightContribution(invalidAnnotation), /annotation/);
    const empty = part('', '');
    empty.content = ''; empty.segments = [];
    assert.deepEqual(highlightContribution(empty), { text: '', spans: [], references: [] });
});
test('embedded grammar and nested scopes reconstruct exact display', () => {
    const result = highlightContribution(part(
        '<script>const message = `hello ${count + 1}`; function work() { return true; }</script>', 'xml'));
    let offset = 0;
    for (const span of result.spans) {
        assert.equal(span.start, offset);
        assert.ok(span.end > span.start);
        offset = span.end;
    }
    assert.equal(offset, result.text.length);
    assert.equal(result.spans.map(span => result.text.slice(span.start, span.end)).join(''), result.text);
    assert.equal(scopeAt(result, 'const'), 'keyword');
    assert.equal(scopeAt(result, 'hello'), 'string');
    assert.equal(scopeAt(result, 'count'), 'subst');
    assert.equal(scopeAt(result, 'work'), 'title.function');
    assert.equal(syntaxStyle(scopeAt(result, 'work'), themes[0]).color, themes[0].colors.information);
});
function withEmitter(root: unknown, run: () => void): void {
    const original = hljs.highlight;
    hljs.highlight = (() => ({ _emitter: { rootNode: root } })) as unknown as typeof hljs.highlight;
    try { run(); } finally { hljs.highlight = original; }
}
test('private adapter inherits scopes without recursive traversal', () => {
    let root: unknown = 'x\n';
    for (let depth = 0; depth < 20000; depth++) { root = { children: [root] }; }
    root = { scope: 'comment', children: [{ scope: 'language:javascript', children: [root] }] };
    withEmitter(root, () => {
        assert.deepEqual(highlightContribution(part('x')), { text: '', spans: [], references: [] });
    });
});
test('private adapter guards version, shape, cycles and exact reconstruction', () => {
    const version = hljs.versionString;
    hljs.versionString = '99.0.0';
    try { assert.throws(() => highlightContribution(part('x')), /11\.9\.0/); }
    finally { hljs.versionString = version; }
    for (const root of [null, {}, { children: [42] }, { scope: 1, children: [] }]) {
        withEmitter(root, () => assert.throws(() => highlightContribution(part('x')), /emitter/));
    }
    const cycle: { children: unknown[] } = { children: [] };
    cycle.children.push(cycle);
    withEmitter(cycle, () => assert.throws(() => highlightContribution(part('x')), /tree/));
    withEmitter({ children: ['y\n'] }, () => {
        assert.throws(() => highlightContribution(part('x')), /reconstruct/);
    });
});
const groups = {
    purple: 'keyword selector-tag literal', accent: 'string regexp addition',
    warning: 'number symbol bullet', information: 'title section built_in type link',
    cyan: 'attr attribute variable template-variable', muted: 'comment quote',
    yellow: 'meta doctag', danger: 'deletion name',
    text: 'subst unknown emphasis strong constructor __proto__ toString params property operator punctuation'
};
test('all 70 palettes retain exact scope colors and publication font policy', () => {
    assert.equal(themes.length, 70);
    for (const theme of themes) {
        for (const [key, scopes] of Object.entries(groups)) {
            for (const scope of scopes.split(' ')) {
                const expected = { color: theme.colors[key as keyof typeof theme.colors],
                    bold: ['keyword', 'variable', 'template-variable', 'strong'].includes(scope),
                    italic: ['comment', 'quote', 'emphasis'].includes(scope) };
                assert.match(expected.color, /^#[0-9a-f]{6}$/i);
                assert.equal(syntaxColor(scope, theme), expected.color);
                assert.equal(syntaxColor(scope + '.nested', theme), expected.color);
                assert.deepEqual(syntaxStyle(scope, theme), expected);
                assert.deepEqual(syntaxStyle(scope + '.nested', theme), expected);
            }
        }
        assert.equal(syntaxColor('', theme), theme.colors.text);
        assert.deepEqual(syntaxStyle('', theme), { color: theme.colors.text, bold: false, italic: false });
    }
});
test('all screen CSS bytes remain unchanged after scope extraction', () => {
    const css = themes.map(theme => themeCss(theme)).join('\n');
    assert.equal(createHash('sha256').update(css).digest('hex'),
        '51ec8b26a6cd75ce6d62c664370f08dd291ca17168eed60083c6092a74bbbd32');
});
function screenStyle(css: string, scope: string): string {
    let declarations = '';
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = rule[1].trim().split(', ');
        if (selectors.includes('.literate-document [class*="hljs-"]') ||
            selectors.includes('.literate-document .hljs-' + scope)) {
            declarations += rule[2];
        }
    }
    return declarations;
}
test('screen scope colors and format-specific decorations cover every palette', () => {
    for (const theme of themes) {
        const css = themeCss(theme);
        for (const [key, scopes] of Object.entries(groups)) {
            for (const scope of scopes.split(' ')) {
                const style = screenStyle(css, scope);
                const colors = [...style.matchAll(/color: var\(--literate-(\w+)\)/g)];
                assert.equal(colors[colors.length - 1][1], key, scope);
                assert.equal(style.includes('font-style: italic;'),
                    ['comment', 'quote', 'emphasis'].includes(scope), scope);
                assert.equal(style.includes('font-weight: bold;'), scope === 'strong', scope);
                assert.equal(style.includes('text-decoration: underline;'), scope === 'link', scope);
            }
        }
    }
});
function rawStyles(blocks: PandocBlock[]): string {
    return blocks.map(block => block.t === 'RawBlock' ? block.c[1]
        : block.t === 'Div' ? rawStyles(block.c[1]) : '').join('\n');
}
test('LaTeX emits every scope with unchanged typography in all themes', async () => {
    const scopes = Object.values(groups).flatMap(value => value.split(' '))
        .flatMap(scope => [scope, scope + '.nested']).concat('');
    const text = scopes.map((_, index) => 'token' + index + '\n').join('');
    const input = '```javascript: ' + tag('styles') + '=\n' + text + '```\n';
    const project = parseProject([{ path: 'index.literate', text: input }]);
    assert.deepEqual(project.diagnostics, []);
    const original = hljs.highlight;
    hljs.highlight = (() => ({ _emitter: { rootNode: { children: scopes.map((scope, index) =>
        ({ scope, children: ['token' + index + '\n'] })) } } })) as unknown as typeof hljs.highlight;
    try {
        for (const theme of themes) {
            const result = await renderLatex(project, { theme: theme.name }, async document =>
                rawStyles(document.blocks));
            assert.deepEqual(result.diagnostics, []);
            scopes.forEach((scope, index) => {
                const base = scope.split('.')[0];
                if (base === 'comment') {
                    assert.doesNotMatch(result.latex!, new RegExp(`token${index}(?!\\d)`));
                    return;
                }
                const key = Object.entries(groups).find(([, names]) => names.split(' ').includes(base))?.[0] || 'text';
                const hex = theme.colors[key as keyof typeof theme.colors].slice(1);
                const bold = ['keyword', 'variable', 'template-variable', 'strong'].includes(base) ? '\\bfseries' : '';
                const italic = ['quote', 'emphasis'].includes(base) ? '\\itshape' : '';
                assert.ok(result.latex?.includes(`\\LitStyle{${hex}}{${bold}}{${italic}}{token${index}}`),
                    theme.name + ': ' + scope);
            });
            assert.doesNotMatch(result.latex!, /\\(?:underline|uline)\{/);
        }
    } finally { hljs.highlight = original; }
});
