import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import * as esbuild from 'esbuild';
import { generatedFromBook } from './authoritative-book';

// Test the authoritative book without writing generated files or importing
// src/themes.ts: the integrating agent owns project registration/generation.
const root = path.resolve(__dirname, '../../..');
const filename = 'literate/themes.literate';
const chapter = fs.readFileSync(path.join(root, filename), 'utf8');
const source = generatedFromBook('src/themes.ts');
const compiled = ts.transpileModule(source.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics, []);

interface Theme {
    name: string;
    dark: boolean;
    colors: Record<string, string>;
}
interface ThemeApi {
    defaultThemeName: string;
    themes: readonly Theme[];
    getTheme(name: string): Theme | undefined;
    themeVariables(theme: Theme): string;
    themeCss(theme: Theme): string;
    mermaidTheme(theme: Theme): { theme: 'base'; themeVariables: Record<string, string | boolean> };
}
const api = {} as ThemeApi;
vm.runInNewContext(compiled.outputText, { exports: api });
const keys = 'background surface surfaceRaised text muted border accent information warning danger purple cyan yellow'.split(' ');
const names = `hermonica aquarium ashes ayu_dark ayu_light bearded-arc blossom_light catppuccin chadracula-evondev chadracula chadtain chocolate dark_horizon decay doomchad everblush everforest everforest_light falcon flex-light flexoki-light flexoki gatekeeper github_dark github_light gruvbox gruvbox_light gruvchad jabuti jellybeans kanagawa material-darker material-lighter melange mito-laser monekai monochrome mountain nano-light nightfox nightlamp nightowl nord oceanic-light oceanic-next one_light onedark onenord onenord_light oxocarbon palenight pasteldark pastelbeans penumbra_dark penumbra_light poimandres radium rosepine-dawn rosepine rxyhn solarized_dark solarized_osaka sweetpastel tokyodark tokyonight tomorrow_night tundra vscode_dark wombat yoru`.split(' ');

function defaultTheme(): Theme {
    const theme = api.getTheme(api.defaultThemeName);
    assert.ok(theme);
    return theme;
}

test('catalogue retains all 70 canonical names, exact mapped colors and immutable entries', () => {
    assert.equal(api.themes.length, 70);
    assert.deepEqual(Array.from(api.themes, theme => theme.name), names);
    assert.equal(new Set(names).size, 70);
    assert.ok(Object.isFrozen(api.themes));
    for (const theme of api.themes) {
        assert.equal(api.getTheme(theme.name), theme);
        assert.deepEqual(Object.keys(theme.colors), keys);
        for (const value of Object.values(theme.colors)) { assert.match(value, /^#[\da-f]{6}$/i); }
        assert.equal(typeof theme.dark, 'boolean');
        assert.ok(Object.isFrozen(theme));
        assert.ok(Object.isFrozen(theme.colors));
    }
    // Independently extracted from the fingerprinted Zig files, in canonical
    // order and the documented mapping. Pins every RGB value, including case.
    const rows = Array.from(api.themes, theme => [theme.name, ...keys.map(key => theme.colors[key])].join(' '));
    assert.equal(createHash('sha256').update(rows.join('\n')).digest('hex'),
        '6fca1be3a2d50e0f356fad45bf416962a892e81ddbffb5e6117ba7d41f78db44');
});

test('default is rosepine-dawn; lookups are exact and prototype-safe', () => {
    assert.equal(api.defaultThemeName, 'rosepine-dawn');
    const theme = defaultTheme();
    assert.equal(theme.dark, false);
    assert.equal(theme.colors.background, '#faf4ed');
    assert.equal(theme.colors.text, '#575279');
    assert.equal(theme.colors.accent, '#286983');
    assert.equal(api.getTheme('hermonica')?.colors.background, '#0a0d10');
    assert.equal(api.getTheme('hermonica')?.dark, true);
    for (const name of ['', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
        'ROSEPINE-DAWN', ' rosepine-dawn', 'pastelDark', 'missing', '</style><script>']) {
        assert.equal(api.getTheme(name), undefined);
    }
    for (const name of ['ayu_light', 'flex-light', 'flexoki-light', 'nano-light', 'penumbra_light']) {
        assert.equal(api.getTheme(name)?.dark, false);
    }
});

test('CSS declarations are complete, kebab-cased and independent of unsafe names', () => {
    const theme = defaultTheme();
    const css = api.themeVariables(theme);
    assert.equal(css.split('\n').length, 13);
    for (const key of keys) {
        const property = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        assert.ok(css.includes(`--literate-${property}: ${theme.colors[key]};`));
    }
    assert.ok(!css.includes('surfaceRaised'));
    const renamed = { ...theme, name: '</style><script>alert(1)</script>' };
    assert.equal(api.themeCss(renamed), api.themeCss(theme));
    assert.equal(api.themeVariables(renamed), css);
    for (const value of ['red', '#fff', '#000000; } body { color:red', '</style>', 'url(https://example.com)', '#123456\n']) {
        const invalid = { ...theme, colors: { ...theme.colors, background: value } };
        assert.throws(() => api.themeVariables(invalid), /Invalid theme color/);
        assert.throws(() => api.themeCss(invalid), /Invalid theme color/);
        assert.throws(() => api.mermaidTheme(invalid), /Invalid theme color/);
    }
});

test('self-contained stylesheet scopes every selector to the document wrapper', () => {
    for (const theme of api.themes) {
        const css = api.themeCss(theme).replace(/\/\*[\s\S]*?\*\//g, '');
        assert.match(css, /display: block/);
        assert.match(css, /width: 100%/);
        assert.match(css, /padding: clamp/);
        assert.match(css, /background: var\(--literate-background\)/);
        assert.match(css, /color: var\(--literate-text\)/);
        assert.ok(!/\bbody\b|:root|@import|https?:|url\(/.test(css));
        for (const match of css.matchAll(/([^{}]+)\{/g)) {
            const selector = match[1].trim();
            if (selector.startsWith('@media')) { continue; }
            for (const part of selector.split(',')) { assert.match(part.trim(), /^\.literate-document(?:\s|$)/); }
        }
        for (const selector of ['h1', 'h6', 'blockquote', 'pre', '.codefragment', '.fragmentname',
            '.fragmentuse', '.hljs-comment', 'table', 'a:focus-visible', '.literate-mermaid svg']) {
            assert.ok(css.includes(`.literate-document ${selector}`), selector);
        }
        const declarations = new Set(Array.from(css.matchAll(/(--literate-[a-z-]+):/g), match => match[1]));
        for (const match of css.matchAll(/var\((--literate-[a-z-]+)\)/g)) { assert.ok(declarations.has(match[1])); }
    }
});

test('fragment panels keep only the outer border while standalone code stays bordered', () => {
    for (const theme of api.themes) {
        const css = api.themeCss(theme);
        assert.match(css, /\.literate-document pre \{[^}]*border: 1px solid var\(--literate-border\);/);
        assert.match(css, /\.literate-document \.codefragment \{[^}]*border: 1px solid var\(--literate-border\);/);
        assert.ok(css.includes('.literate-document .codefragment pre { border: 0; }'));
    }
});

function upstreamNotice(): string {
    const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const fullText = /```text\n([\s\S]*?)\n```/.exec(notice);
    assert.ok(fullText, 'the provenance document must retain the full upstream notice');
    return fullText[1];
}

test('exported stylesheet appends the full MIT notice in a safe retained comment', () => {
    const notice = upstreamNotice();
    assert.ok(!/<\/|\*\//.test(notice), 'notice must be safe inside inline CSS');
    for (const theme of api.themes) {
        const css = api.themeCss(theme);
        assert.ok(css.endsWith(`/*!\n${notice}\n*/\n`));
        assert.ok(!/<\//.test(css), 'CSS must not close an HTML style element');
    }
});

test('highlight token reset precedes mappings and Mermaid errors use role alert', () => {
    const css = api.themeCss(defaultTheme()).replace(/\/\*[\s\S]*?\*\//g, '');
    const reset = '.literate-document [class*="hljs-"] { color: var(--literate-text); background: transparent; }';
    const resetIndex = css.indexOf(reset);
    assert.ok(resetIndex >= 0, 'unmapped tokens must not inherit host highlight colors');
    const mappings = Array.from(css.matchAll(/\.literate-document \.hljs-[\w-]+/g));
    assert.ok(mappings.length > 0);
    for (const mapping of mappings) { assert.ok(mapping.index! > resetIndex, mapping[0]); }
    assert.ok(css.includes('.literate-document .literate-mermaid[role="alert"] { color: var(--literate-danger);'));
    assert.ok(!css.includes('[data-error]'));
});

test('Mermaid patch covers diagrams without replacing caller security or limits', () => {
    for (const theme of api.themes) {
        const patch = api.mermaidTheme(theme);
        assert.deepEqual(Object.keys(patch), ['theme', 'themeVariables']);
        assert.equal(patch.theme, 'base');
        const v = patch.themeVariables;
        assert.equal(v.darkMode, theme.dark);
        assert.equal(v.background, theme.colors.background);
        assert.equal(v.textColor, theme.colors.text);
        assert.equal(v.mainBkg, theme.colors.surface);
        assert.equal(v.actorTextColor, theme.colors.text);
        assert.equal(v.classText, theme.colors.text);
        assert.equal(v.attributeBackgroundColorEven, theme.colors.surfaceRaised);
        assert.equal(v.pie1, theme.colors.accent);
        assert.equal(v.pieLegendTextColor, theme.colors.text);
        assert.match(String(v.fontFamily), /system-ui/);
        const configuration = { securityLevel: 'strict', startOnLoad: false, maxTextSize: 5000, maxEdges: 100, ...patch };
        assert.equal(configuration.securityLevel, 'strict');
        assert.equal(configuration.startOnLoad, false);
        assert.equal(configuration.maxTextSize, 5000);
        assert.equal(configuration.maxEdges, 100);
    }
});

test('browser module bundles without imports, external files or DOM globals', () => {
    const bundle = esbuild.buildSync({ stdin: { contents: source.content, loader: 'ts' },
        bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', globalName: 'literateThemes' });
    const sandbox: { literateThemes?: ThemeApi } = {};
    vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
    assert.equal(sandbox.literateThemes?.themes.length, 70);
    assert.equal(sandbox.literateThemes?.getTheme('rosepine-dawn')?.dark, false);
    assert.ok(sandbox.literateThemes?.themeCss(defaultTheme()).includes(upstreamNotice()),
        'the full notice must survive bundle minification as runtime string data');
    assert.ok(!/^import\s/m.test(source.content));
});

test('provenance documents the local snapshot and full corrected MIT notice', () => {
    const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const text of ['NvChad/base46', 'v2.5/LICENSE', 'v3.0/LICENSE', 'pastelDark.lua',
        'nvim-base16.lua', 'Copyright © 2019 Ashkan Kiani',
        'Permission is hereby granted, free of charge',
        'The above copyright notice and this permission notice shall be included',
        'THE SOFTWARE IS PROVIDED "AS IS"', 'OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
        'b32d7ce1eed5229fa408dfa0df14be435719bdef207b650da55d2f73b4d5b107',
        '9297ec52dff6ba963fb92291f9e058d36393402781e5b1a0ec6d3a5d2903d159']) {
        assert.ok(notice.includes(text), text);
    }
    assert.match(chapter, /black black2 one_bg white light_grey grey green blue orange red purple cyan yellow/);
});
