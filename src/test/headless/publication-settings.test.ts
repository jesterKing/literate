import assert = require('node:assert/strict');
import { test } from 'node:test';
import { parseProject } from '../../engine';
import { preparePandoc } from '../../publication-pandoc';
import { resolvePublicationSettings } from '../../publication-settings';
import type { PublicationFonts, PublicationFontSizes,
    PublicationSettingsResult } from '../../publication-settings';

const defaults: PublicationFonts = {
    body: 'Latin Modern Roman', heading: 'Monofur Nerd Font',
    code: 'Lilex Nerd Font', fragment: 'Monofur Nerd Font', note: 'Latin Modern Roman'
};
const sizeDefaults: PublicationFontSizes = { body: 11, code: 10, diagram: 16, rail: 9 };
const fence = (content: string, info = 'SETTINGS') => '```' + info + '\n' + content + '\n```\n';
function resolve(text: string, path = 'index.literate'): PublicationSettingsResult {
    const project = parseProject([{ path, text }]);
    assert.deepEqual(project.diagnostics, []);
    return resolvePublicationSettings(project);
}
test('publication settings defaults and root-only scope', () => {
    const expected = { fonts: defaults, fontSizes: sizeDefaults, codeLigatures: true, diagnostics: [] };
    assert.deepEqual(resolvePublicationSettings(parseProject([])), expected);
    assert.deepEqual(resolve(''), expected);
    for (const path of ['chapter.literate', 'chapters/index.literate', 'Index.literate']) {
        assert.deepEqual(resolve(fence('font-body=Other\nfont-code-ligatures=bad'), path), expected);
    }
    const project = parseProject([
        { path: 'chapter.literate', text: fence('font-body=Chapter\nfont-note=') },
        { path: './parts/../index.literate', text: fence('font-body=Root') }
    ]);
    assert.deepEqual(project.diagnostics, []);
    assert.equal(resolvePublicationSettings(project).fonts.body, 'Root');
    assert.deepEqual(resolvePublicationSettings(project).diagnostics, []);
    const rejected = parseProject([{ path: '.\\index.literate', text: fence('font-body=Wrong') }]);
    assert.ok(rejected.diagnostics.some(d => d.message === 'Invalid source path'));
    assert.deepEqual(resolvePublicationSettings(rejected), expected);
    const changed = resolve('');
    changed.fonts.body = 'Changed'; changed.fontSizes.body = 20;
    assert.deepEqual(resolve(''), expected);
});
test('publication settings select all roles and delay note inheritance', () => {
    const result = resolve(fence('font-body = Body 2.0\nfont-heading= Heading-Font \n' +
        'font-code= Code Font \nfont-fragment= Fragment Font\nfont-code-ligatures= off '));
    assert.deepEqual(result, { fonts: { body: 'Body 2.0', heading: 'Heading-Font',
        code: 'Code Font', fragment: 'Fragment Font', note: 'Body 2.0' },
        fontSizes: sizeDefaults, codeLigatures: false, diagnostics: [] });
    const inherited = resolve(fence('font-note=\nfont-body=First') + fence('font-body=Last'));
    assert.equal(inherited.fonts.note, 'Last');
    assert.equal(inherited.diagnostics.length, 1);
    const explicit = resolve(fence('font-note=Notes') + fence('font-body=Last\nfont-note=bad/path'));
    assert.equal(explicit.fonts.note, 'Notes');
    assert.equal(explicit.diagnostics.length, 1);
});
test('publication settings retain every invalid repetition', () => {
    const result = resolve(fence('font-body=\nfont-body=First\nfont-body=bad/path\n' +
        'font-body=Last\nfont-body=\\input{x}\nfont-code-ligatures=no\n' +
        'font-code-ligatures=off\nfont-code-ligatures=ON') +
        fence('font-code-ligatures=on\nfont-code-ligatures='));
    assert.equal(result.fonts.body, 'Last');
    assert.equal(result.fonts.note, 'Last');
    assert.equal(result.codeLigatures, true);
    assert.deepEqual(result.diagnostics.map(d => d.line), [1, 3, 5, 6, 8, 12]);
    assert.ok(result.diagnostics.every(d => d.path === 'index.literate' && d.column === 0));
    assert.match(result.diagnostics[0].message, /font-body.*simple family name/);
    assert.match(result.diagnostics[3].message, /font-code-ligatures.*on or off/);
});
test('publication settings enforce the simple ASCII family grammar', () => {
    const invalid = ['', '   ', 'A'.repeat(101), '.Font', '-Font', 'École', 'A_B',
        'A/B', 'A\\B', 'A{B}', 'A%B', 'A#B', 'A$B', 'A&B', 'A~B', 'A^B', 'A[B]', 'A\tB'];
    for (const role of ['body', 'heading', 'code', 'fragment', 'note'] as const) {
        for (const value of invalid) {
            const result = resolve(fence('font-' + role + '=' + value));
            assert.equal(result.fonts[role], defaults[role], role + ': ' + value);
            assert.equal(result.diagnostics.length, 1, role + ': ' + value);
        }
        for (const value of ['A', '0', 'A'.repeat(100), 'Family 2.0-Pro']) {
            const result = resolve(fence('font-' + role + '=  ' + value + '  '));
            assert.equal(result.fonts[role], value);
            assert.deepEqual(result.diagnostics, []);
        }
    }
});
test('publication font sizes are bounded decimal values with explicit units', () => {
    const selected = resolve(fence('font-size-body=8\nfont-size-body=12.5\n' +
        'font-size-code=6.25\nfont-size-diagram=48\nfont-size-rail=7.5'));
    assert.deepEqual(selected.fontSizes, { body: 12.5, code: 6.25, diagram: 48, rail: 7.5 });
    assert.deepEqual(selected.diagnostics, []);

    for (const [role, minimum, maximum] of [
        ['body', 8, 24], ['code', 6, 24], ['diagram', 8, 48], ['rail', 7, 14]
    ] as const) {
        for (const value of [String(minimum - 0.01), String(maximum + 0.01),
            '12pt', '1e1', '+10', '-10', '10.123', 'NaN', '']) {
            const result = resolve(fence(`font-size-${role}=${value}`));
            assert.equal(result.fontSizes[role], sizeDefaults[role], `${role}: ${value}`);
            assert.equal(result.diagnostics.length, 1, `${role}: ${value}`);
            assert.match(result.diagnostics[0].message, new RegExp(`${minimum}.*${maximum}`));
        }
    }
    const repeated = resolve(fence('font-size-body=12\nfont-size-body=bad\nfont-size-body=13'));
    assert.equal(repeated.fontSizes.body, 13);
    assert.deepEqual(repeated.diagnostics.map(d => d.line), [2]);
});
test('publication settings ignore unrelated keys and non-settings text', () => {
    const text = fence('theme=unknown\nFont-body=\nfont-body-extra=\nfont-note-other=\nauthors=X') +
        fence('font-body=Wrong', 'settings') + fence('font-body=Wrong', 'text') +
        'font-body=Wrong\n\n    font-body=Wrong\n';
    assert.deepEqual(resolve(text), { fonts: defaults, fontSizes: sizeDefaults,
        codeLigatures: true, diagnostics: [] });
});

test('publication settings map zero-based lines across newlines and containers', () => {
    const lines = ['# Title', '', '> ```SETTINGS', '> font-body=Quoted', '> font-heading=',
        '> ```', '', '- item', '', '  ```SETTINGS', '  font-code-ligatures=off',
        '  font-note=bad/path', '  ```'];
    for (const newline of ['\n', '\r\n', '\r']) {
        const result = resolve(lines.join(newline));
        assert.equal(result.fonts.body, 'Quoted');
        assert.equal(result.fonts.note, 'Quoted');
        assert.equal(result.codeLigatures, false);
        assert.deepEqual(result.diagnostics.map(d => [d.line, d.column]), [[4, 0], [11, 0]]);
    }
    assert.equal(resolve(fence('font-body=')).diagnostics[0].line, 1);
});
test('publication settings leave source diagnostics to the preparation gate', () => {
    const project = parseProject([{ path: 'index.literate', text: fence('font-body=A\0B') }]);
    assert.ok(project.diagnostics.some(d => /NUL/.test(d.message)));
    const before = JSON.stringify(project);
    assert.deepEqual(resolvePublicationSettings(project), {
        fonts: defaults, fontSizes: sizeDefaults, codeLigatures: true, diagnostics: []
    });
    const prepared = preparePandoc(project, () => { throw new Error('must not render'); });
    assert.equal(prepared.document, undefined);
    assert.deepEqual(prepared.diagnostics, project.diagnostics);
    assert.equal(JSON.stringify(project), before);
});
