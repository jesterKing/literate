import assert = require('node:assert/strict');
import { test } from 'node:test';
import hljs from 'highlight.js';
import { parseProject } from '../../engine';
import { themes } from '../../themes';
import { highlightContribution, syntaxStyle } from '../../publication-highlight';
const tag = (name: string) => '<' + '<' + name + '>>';
function part(body: string, language = 'javascript') {
    const fence = (header: string, content: string) => '```' + header + '\n' + content + '\n```\n';
    const result = parseProject([{ path: 'index.literate', text:
        fence(language + ': ' + tag('main') + '=', body) + fence(': ' + tag('piece') + '=', 'x') }]);
    assert.deepEqual(result.diagnostics, []);
    return result.publication.contributions[0];
}
function scopeAt(result: ReturnType<typeof highlightContribution>, marker: string): string {
    const offset = result.text.indexOf(marker);
    assert.ok(offset >= 0);
    return result.spans.find(span => span.start <= offset && offset < span.end)!.scope;
}
test('whole-block highlighting preserves comment and template context around references', () => {
    const cases = [
        { body: '/* before\n' + tag('piece') + '\nCOMMENT_AFTER\n*/\nconst ready = true;',
            marker: 'COMMENT_AFTER', scope: 'comment' },
        { body: 'const message = `before\n' + tag('piece') + '\nTEMPLATE_AFTER ${count + 1}`;',
            marker: 'TEMPLATE_AFTER', scope: 'string' }
    ];
    for (const fixture of cases) {
        const result = highlightContribution(part(fixture.body));
        assert.equal(scopeAt(result, fixture.marker), fixture.scope);
        assert.equal(result.references.length, 1);
        const suffix = result.text.slice(result.references[0].end);
        assert.notEqual(scopeAt(highlightContribution(part(suffix)), fixture.marker), fixture.scope);
        assert.equal(scopeAt(result, 'const'), 'keyword');
    }
});
test('literal unescape maps repeated references after emoji in UTF-16', () => {
    const input = part('\\' + tag('literal') + ' 😀 ' + tag('piece') + '/' + tag('piece'), 'unknown-language');
    const snapshot = JSON.stringify(input);
    const result = highlightContribution(input);
    assert.equal(result.text, tag('literal') + ' 😀 ' + tag('piece') + '/' + tag('piece') + '\n');
    assert.equal(result.references.length, 2);
    assert.equal(result.references[0].start, tag('literal').length + 4);
    for (const ref of result.references) {
        assert.equal(result.text.slice(ref.start, ref.end), tag('piece'));
        assert.equal(ref.name, 'piece');
        assert.ok(ref.target);
    }
    assert.deepEqual(result.spans, [{ start: 0, end: result.text.length, scope: '' }]);
    assert.equal(JSON.stringify(input), snapshot);
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
        assert.deepEqual(highlightContribution(part('x')).spans, [{ start: 0, end: 2, scope: 'comment' }]);
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
test('all 70 palettes retain exact scope colors and publication font policy', () => {
    assert.equal(themes.length, 70);
    const groups = {
        purple: 'keyword selector-tag literal', accent: 'string regexp addition',
        warning: 'number symbol bullet', information: 'title section built_in type link',
        cyan: 'attr attribute variable template-variable', muted: 'comment quote',
        yellow: 'meta doctag', danger: 'deletion name',
        text: 'subst unknown emphasis strong constructor __proto__'
    };
    for (const theme of themes) {
        for (const [key, scopes] of Object.entries(groups)) {
            for (const scope of scopes.split(' ')) {
                const expected = { color: theme.colors[key as keyof typeof theme.colors],
                    bold: ['keyword', 'variable', 'template-variable', 'strong'].includes(scope),
                    italic: ['comment', 'quote', 'emphasis'].includes(scope) };
                assert.match(expected.color, /^#[0-9a-f]{6}$/i);
                assert.deepEqual(syntaxStyle(scope, theme), expected);
                assert.deepEqual(syntaxStyle(scope + '.nested', theme), expected);
            }
        }
        assert.deepEqual(syntaxStyle('', theme), { color: theme.colors.text, bold: false, italic: false });
    }
});
