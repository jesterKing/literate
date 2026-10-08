import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as esbuild from 'esbuild';
import { generateProject } from '../../engine';
import { themes, themeCss } from '../../themes';

const root = path.resolve(__dirname, '../../..');
function chapterSource(filename: string, output: string): string {
    const result = generateProject([{ path: filename,
        text: fs.readFileSync(path.join(root, filename), 'utf8') }]);
    assert.deepEqual(result.diagnostics, []);
    const client = result.files.find(file => file.path === output);
    assert.ok(client, `the authoritative source must emit ${output}`);
    return client.content;
}
function bookSource(output: string): string {
    const names = fs.readdirSync(path.join(root, 'literate')).filter(name => name.endsWith('.literate'));
    const documents = [{ path: 'index.literate', text: fs.readFileSync(path.join(root, 'index.literate'), 'utf8') },
        ...names.map(name => ({ path: `literate/${name}`,
            text: fs.readFileSync(path.join(root, 'literate', name), 'utf8') }))];
    const result = generateProject(documents, { 'tssrc.template': fs.readFileSync(path.join(root, 'tssrc.template'), 'utf8') });
    assert.deepEqual(result.diagnostics, []);
    const generated = result.files.find(file => file.path === output);
    assert.ok(generated, `the authoritative book must emit ${output}`);
    return generated.content;
}

function bundle(stub: boolean) {
    return esbuild.build({
        stdin: { contents: bookSource('src/mermaid-preview.js'), loader: 'js',
            resolveDir: path.resolve(__dirname, '../../..'), sourcefile: 'mermaid-preview.js' },
        bundle: true, write: false, platform: 'browser', format: 'iife',
        // Resolve the catalogue in memory: this test must not require generated files.
        plugins: [{ name: 'theme-catalogue', setup(build) {
            build.onResolve({ filter: /^\.\/themes$/ }, () => ({ path: 'themes', namespace: 'catalogue' }));
            build.onLoad({ filter: /.*/, namespace: 'catalogue' }, () => ({
                contents: chapterSource('literate/themes.literate', 'src/themes.ts'), loader: 'ts'
            }));
        } }, ...(stub ? [{ name: 'mermaid-stub', setup(build: esbuild.PluginBuild) {
            build.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: 'export default globalThis.mermaidStub;', loader: 'js'
            }));
        } }] : [])]
    });
}

class Container {
    isConnected = true;
    private markup: string;
    private text: string;
    readonly attributes = new Map([['class', 'literate-mermaid source-line'], ['data-line', '7']]);
    htmlWrites: string[] = [];
    constructor(source: string) { this.text = source; this.markup = this.escape(source); }
    private escape(value: string) {
        return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    get innerHTML() { return this.markup; }
    set innerHTML(value: string) {
        this.htmlWrites.push(value);
        this.markup = value;
        this.text = 'rendered SVG text is not diagram source';
    }
    get textContent() { return this.text; }
    set textContent(value: string) { this.text = value; this.markup = this.escape(value); }
    matches(selector: string) {
        assert.equal(selector, 'pre.literate-mermaid');
        return (this.attributes.get('class') || '').split(' ').includes('literate-mermaid');
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
}

type Configuration = { theme: string; themeVariables: { background: string; textColor: string };
    [key: string]: unknown };
type Render = { id: string; source: string; config: Configuration;
    resolve(value: { svg: string; bindFunctions?: () => void }): void; reject(error: unknown): void };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const bundledClient = bundle(true);

async function fixture(sources: string[], loading = false, initialTheme: string | null = 'rosepine-dawn') {
    const elements = sources.map(source => new Container(source));
    const events = new Map<string, () => void>();
    const renders: Render[] = [];
    const configs: Configuration[] = [];
    const classes = new Set(['vscode-light']);
    const occupied = new Set<string>();
    let notify = () => {};
    let config: Configuration;
    let active = false;
    const body = { classList: { contains: (name: string) => classes.has(name) } };
    const styles: { id: string; textContent: string }[] = [];
    let wrapper = initialTheme === null ? null : {
        getAttribute: (name: string) => {
            assert.equal(name, 'data-literate-theme');
            return initialTheme;
        }
    };
    const document = {
        body, readyState: loading ? 'loading' : 'complete',
        head: { appendChild: (sheet: typeof styles[number]) => styles.push(sheet) },
        createElement: (tag: string) => {
            assert.equal(tag, 'style');
            return { id: '', textContent: '' };
        },
        getElementById: (id: string) => styles.find(sheet => sheet.id === id) || (occupied.has(id) ? {} : null),
        querySelector: (selector: string) => {
            assert.equal(selector, '.literate-document');
            return wrapper;
        },
        querySelectorAll: (selector: string) => elements.filter(element => element.matches(selector)),
        addEventListener: (name: string, listener: () => void) => { events.set(name, listener); }
    };
    const mermaidStub = {
        initialize(value: Configuration) {
            assert.equal(active, false, 'initialize must not race an outstanding render');
            config = value;
            configs.push(value);
        },
        render(id: string, source: string) {
            assert.equal(active, false, 'renders must be serialized');
            active = true;
            return new Promise<{ svg: string; bindFunctions?: () => void }>((resolve, reject) => {
                renders.push({ id, source, config,
                    resolve(value) { active = false; resolve(value); },
                    reject(error) { active = false; reject(error); } });
            });
        }
    };
    class Observer {
        constructor(callback: () => void) { notify = callback; }
        observe(target: unknown, options: unknown) {
            assert.equal(target, body);
            assert.equal(JSON.stringify(options), JSON.stringify({
                attributes: true, subtree: true, attributeFilter: ['data-literate-theme']
            }));
        }
    }
    vm.runInNewContext((await bundledClient).outputFiles[0].text, {
        document, window: { addEventListener: document.addEventListener },
        // Browser global names are intentionally capitalized.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        MutationObserver: Observer, mermaidStub, Error
    });
    return { elements, events, renders, configs, occupied, styles,
        update: () => events.get('vscode.markdown.updateContent')!(),
        theme(name: string) { initialTheme = name; notify(); },
        vscodeTheme(name: string) { classes.clear(); classes.add(name); },
        replaceWrapper(name: string | null) {
            wrapper = name === null ? null : { getAttribute: () => name };
        },
        async finish(index: number, svg = '<svg role="img"></svg>') {
            renders[index].resolve({ svg, bindFunctions: () => assert.fail('must not bind callbacks') });
            await tick();
        }
    };
}

test('auto-start is disabled before DOM readiness even without Literate diagrams', async () => {
    const f = await fixture([], true);
    assert.equal(f.configs.length, 1);
    assert.equal(f.configs[0].startOnLoad, false);
    f.events.get('DOMContentLoaded')!();
    f.update();
    await tick();
    assert.equal(f.renders.length, 0);
});

test('live preview installs the exact shared stylesheet for all 70 themes without diagrams', async () => {
    const f = await fixture([], false, themes[0].name);
    assert.equal(f.styles[0].textContent, themeCss(themes[0]));
    for (const theme of themes) {
        f.theme(theme.name);
        assert.equal(f.styles.length, 1);
        assert.equal(f.styles[0].textContent, themeCss(theme), theme.name);
    }
    for (const theme of themes) {
        f.replaceWrapper(theme.name);
        f.update();
        assert.equal(f.styles[0].textContent, themeCss(theme), theme.name);
    }
    assert.equal(f.renders.length, 0);
});

test('documents without diagrams get one scoped stylesheet on startup and updates', async () => {
    const f = await fixture([], true, 'github_light');
    assert.equal(f.styles.length, 0);
    f.events.get('DOMContentLoaded')!();
    assert.equal(f.styles.length, 1);
    const sheet = f.styles[0];
    assert.equal(sheet.id, 'literate-theme-style');
    assert.ok(sheet.textContent.includes('--literate-background: #ffffff;'));
    // Every selector, including each comma-separated selector, stays in the wrapper.
    for (const match of sheet.textContent.matchAll(/([^{}]+)\{/g)) {
        if (match[1].trim().startsWith('@media')) { continue; }
        for (const selector of match[1].split(',')) {
            assert.ok(selector.trim().startsWith('.literate-document'), selector);
        }
    }
    f.theme('rosepine');
    assert.ok(sheet.textContent.includes('--literate-background: #191724;'));
    f.replaceWrapper('rosepine-dawn');
    f.update();
    assert.ok(sheet.textContent.includes('--literate-background: #faf4ed;'));
    assert.equal(f.styles.length, 1);
    assert.equal(f.styles[0], sheet);
    assert.equal(f.renders.length, 0);
});

for (const name of [null, '', 'not-a-theme', '__proto__', '</style><script>bad</script>']) {
    test(`missing or invalid wrapper theme falls back to Rose Pine Dawn: ${name}`, async () => {
        const f = await fixture(['graph TD; A-->B'], false, name);
        assert.equal(f.renders[0].config.theme, 'base');
        assert.equal(f.renders[0].config.themeVariables.background, '#faf4ed');
        assert.ok(f.styles[0].textContent.includes('--literate-background: #faf4ed;'));
        assert.ok(!f.styles[0].textContent.includes('<script>'));
        await f.finish(0);
        f.replaceWrapper('another-invalid-name');
        f.update();
        await tick();
        assert.equal(f.renders.length, 1, 'fallback shares the canonical name render key');
    });
}

test('browser IIFE starts after DOM readiness, preserves metadata and skips completed content', async () => {
    const f = await fixture(['graph TD\nA["<escaped> & text"]'], true);
    assert.equal(f.renders.length, 0);
    f.occupied.add('literate-mermaid-1-1');
    f.events.get('DOMContentLoaded')!();
    assert.equal(f.renders[0].id, 'literate-mermaid-1-2');
    assert.equal(f.renders[0].source, 'graph TD\nA["<escaped> & text"]');
    await f.finish(0);
    f.update();
    f.theme('rosepine-dawn');
    await tick();
    assert.equal(f.renders.length, 1);
    assert.equal(f.elements[0].attributes.get('class'), 'literate-mermaid source-line');
    assert.equal(f.elements[0].attributes.get('data-line'), '7');
    assert.deepEqual(f.elements[0].htmlWrites, ['<svg role="img"></svg>']);
    const config = f.configs[0];
    assert.equal(config.securityLevel, 'strict');
    assert.equal(config.suppressErrorRendering, true);
    assert.equal(config.startOnLoad, false);
    assert.equal(config.maxTextSize, 50000);
    assert.equal(config.maxEdges, 500);
    assert.equal(config.htmlLabels, false);
    assert.equal(config.fontFamily, 'sans-serif');
});

test('theme changes during rendering serialize work and discard stale SVG', async () => {
    const f = await fixture(['graph TD; A-->B', 'graph TD; C-->D']);
    f.theme('rosepine');
    f.update();
    f.update();
    assert.equal(f.configs.length, 2);
    await f.finish(0, '<svg>stale light</svg>');
    assert.deepEqual(f.elements[0].htmlWrites, []);
    assert.equal(f.renders[1].config.theme, 'base');
    assert.equal(f.renders[1].config.themeVariables.background, '#191724');
    await f.finish(1);
    assert.equal(f.renders[2].source, 'graph TD; A-->B');
    assert.equal(f.renders[2].config.themeVariables.background, '#191724');
    await f.finish(2);
    f.theme('rosepine-dawn');
    await f.finish(3);
    await f.finish(4);
    assert.equal(f.renders[3].source, 'graph TD; A-->B');
    assert.equal(f.renders[4].source, 'graph TD; C-->D');
    assert.equal(new Set(f.renders.map(render => render.id)).size, 5);
});

test('VS Code themes do not override the document palette', async () => {
    const f = await fixture(['graph TD; A-->B']);
    await f.finish(0);
    const css = f.styles[0].textContent;
    for (const name of ['vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-light']) {
        f.vscodeTheme(name);
        f.update();
        await tick();
        assert.equal(f.renders.length, 1);
        assert.equal(f.styles[0].textContent, css);
    }
    assert.equal(f.renders[0].config.theme, 'base');
    assert.equal(f.renders[0].config.themeVariables.background, '#faf4ed');
    assert.equal(f.renders[0].config.themeVariables.textColor, '#575279');
});

test('distinct light palettes re-render retained source and replace SVG', async () => {
    const source = 'graph TD; A-->B';
    const f = await fixture([source]);
    await f.finish(0, '<svg>dawn</svg>');
    f.theme('github_light');
    assert.equal(f.renders[1].source, source);
    assert.equal(f.renders[1].config.theme, 'base');
    assert.equal(f.renders[1].config.themeVariables.background, '#ffffff');
    assert.ok(f.styles[0].textContent.includes('--literate-background: #ffffff;'));
    await f.finish(1, '<svg>github</svg>');
    assert.deepEqual(f.elements[0].htmlWrites, ['<svg>dawn</svg>', '<svg>github</svg>']);
    f.theme('github_light');
    await tick();
    assert.equal(f.renders.length, 2);
});

test('replacement DOM and in-place source edits render again without touching generic Mermaid blocks', async () => {
    const f = await fixture(['graph TD; A-->B']);
    const old = f.elements[0];
    old.isConnected = false;
    f.elements[0] = new Container('graph TD; A-->B');
    f.replaceWrapper('github_light');
    const generic = new Container('unrelated');
    generic.attributes.set('class', 'mermaid');
    f.elements.push(generic);
    f.update();
    await f.finish(0);
    assert.deepEqual(old.htmlWrites, []);
    assert.equal(f.renders[1].source, 'graph TD; A-->B');
    assert.equal(f.renders[1].config.themeVariables.background, '#ffffff');
    assert.ok(f.styles[0].textContent.includes('--literate-background: #ffffff;'));
    assert.equal(f.styles.length, 1);
    await f.finish(1);
    f.elements[0].textContent = 'graph TD; X-->Y';
    f.update();
    f.elements[0].textContent = 'graph TD; New-->Source';
    f.update();
    await f.finish(2, '<svg>stale edit</svg>');
    assert.equal(f.elements[0].textContent, 'graph TD; New-->Source');
    assert.equal(f.renders[3].source, 'graph TD; New-->Source');
    await f.finish(3);
    assert.equal(generic.textContent, 'unrelated');
    assert.deepEqual(generic.htmlWrites, []);
});

test('errors are accessible plain text, retain source, skip repeats and recover', async () => {
    const source = 'graph TD; A["<img src=x onerror=bad>"]';
    const f = await fixture([source, 'graph TD; Valid-->Next']);
    f.renders[0].reject(new Error('<script>bad error</script>'));
    await tick();
    assert.equal(f.elements[0].attributes.get('role'), 'alert');
    assert.equal(f.elements[0].attributes.get('aria-label'), 'Mermaid diagram rendering error');
    assert.ok(f.elements[0].textContent.includes(source));
    assert.ok(f.elements[0].innerHTML.includes('&lt;script&gt;'));
    assert.deepEqual(f.elements[0].htmlWrites, []);
    await f.finish(1);
    f.update();
    await tick();
    assert.equal(f.renders.length, 2);
    f.theme('rosepine');
    assert.equal(f.renders[2].source, source);
    await f.finish(2);
    await f.finish(3);
    assert.equal(f.elements[0].attributes.has('role'), false);
    assert.equal(f.elements[0].attributes.has('aria-label'), false);
});

for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\ngraph TD; A-->B',
    '%%{config: {"maxEdges":999999}}%%\ngraph TD; A-->B',
    ' \n---\nconfig:\n  securityLevel: loose\n---\ngraph TD; A-->B',
    'x'.repeat(50001)
]) {
    test(`rejects unsafe configuration or excessive text: ${source.slice(0, 30)}`, async () => {
        const f = await fixture([source]);
        await tick();
        assert.equal(f.renders.length, 0);
        assert.equal(f.configs.length, 1);
        assert.equal(f.elements[0].attributes.get('role'), 'alert');
        assert.ok(f.elements[0].textContent.endsWith(source));
        f.elements[0].textContent = 'graph TD; Fixed-->Source';
        f.update();
        await f.finish(0);
        assert.equal(f.elements[0].attributes.has('role'), false);
    });
}

test('real Mermaid dependency bundles into a local browser IIFE', async () => {
    const result = await bundle(false);
    assert.equal(result.outputFiles.length, 1);
    assert.ok(result.outputFiles[0].text.includes('literate-mermaid-'));
    assert.ok(!/\bimport\s*\(/.test(result.outputFiles[0].text), 'bundle must not leave dynamic imports');
});
