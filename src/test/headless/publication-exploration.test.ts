/* DOM API names and template paths deliberately retain their public spelling. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { parseProject, generateProject } from '../../engine';
import { renderScreenCode, renderScreenExploration } from '../../publication-screen';
import { explorationPayload, serializeExploration, explorationBrowserScript, explorationLimits,
    ExplorationPayload } from '../../publication-exploration';

const fence = (name: string, body: string) => '```text : <<' + name + '>>=\n' + body + '\n```\n';
const sources = () => [
    { path: 'index.literate', text: '[Defs](nested/defs.html)\n\n' + fence('main', '<<child>> / \\<<literal>>') },
    { path: 'nested/defs.literate', text: fence('child', '</script><img src=x onerror=alert(1)> & <<leaf>>')
        + fence('leaf', 'leaf body') }
];
const model = () => parseProject(sources()).publication;
const payloadOf = (html: string) => JSON.parse(html.match(/class="literate-exploration-data">([^]*?)<\/script>/)![1]) as ExplorationPayload;

test('real screen renderer keeps links and literal escapes inert without dead buttons', () => {
    const publication = model();
    const main = publication.contributions.find(part => part.definition.path === 'index.literate')!;
    const code = renderScreenCode(main, publication, 'html');
    assert.equal((code.match(/data-literate-explore=/g) || []).length, 1);
    assert.match(code, /href="\.\/nested\/defs.html#f-/);
    assert.match(code, /&lt;&lt;literal&gt;&gt;/);
    assert.doesNotMatch(code, /<button|onclick/);
    const rendered = renderScreenExploration(publication, 'index.literate', 'html');
    const payload = payloadOf(rendered);
    assert.equal(Object.keys(payload.parts).length, publication.contributions.length);
    assert.match(JSON.stringify(payload.parts), /<\/script><img/);
    assert.doesNotMatch(rendered.split('</script>')[0], /<img|<\/script>/);
    new vm.Script(explorationBrowserScript());
    const documents = sources();
    documents[0].text = '```SETTINGS\ntemplate=page.template\n```\n' + documents[0].text;
    const generated = generateProject(documents, { 'page.template': '[CONTENT]' });
    assert.deepEqual(generated.diagnostics, []);
    const html = generated.files.find(file => file.path === 'index.html')!.content;
    assert.match(html, /literate-exploration-data/);
    const inline = html.match(/<script>([^]*?)<\/script>/);
    assert.ok(inline, 'usable references include an executable standalone initializer');
    new vm.Script(inline[1]);
    assert.doesNotMatch(html, /<button/);
});

test('exploration is absent without usable document-local reference uses', () => {
    const unrelated = sources();
    for (const text of ['Ordinary prose.', '```text\n<<child>>\n```\n',
        fence('alone', 'no references'), fence('literal', '\\<<child>>'), fence('missing', '<<absent>>'),
        '```TERM alpha "Alpha"\nDefinition.\n```\n\n[Alpha](term:alpha)']) {
        const publication = parseProject([...unrelated, { path: 'plain.literate', text }]).publication;
        for (const format of ['html', 'preview'] as const) {
            assert.equal(renderScreenExploration(publication, 'plain.literate', format,
                () => assert.fail('unrelated capabilities must not be resolved')), '');
        }
    }
    const publication = model();
    assert.equal(renderScreenExploration(publication, 'index.literate', 'preview', () => undefined), '');
    assert.match(renderScreenExploration(publication, 'index.literate', 'preview', () => 'https://cap.invalid/use'),
        /literate-exploration-data/);
});

test('content-only templates preserve ordinary Markdown without exploration scripts', () => {
    const text = '```SETTINGS\ntemplate=page.template\n```\n\nOrdinary prose.\n';
    const result = generateProject([{ path: 'index.literate', text }], { 'page.template': '[CONTENT]' });
    assert.deepEqual(result.diagnostics, []);
    const html = result.files.find(file => file.path === 'index.html')!.content;
    assert.equal(html.slice(html.indexOf('<div class="literate-document"')),
        '<div class="literate-document" data-literate-theme="rosepine-dawn"><p>Ordinary prose.</p>\n</div>');
    assert.doesNotMatch(html, /<script|literate-exploration/);
});

test('all preview families use caller capabilities, including unopened nested references', () => {
    const publication = model(), seen: string[] = [];
    const json = explorationPayload(publication, 'index.literate', 'preview', target => {
        seen.push(target); return 'https://cap.invalid/' + target;
    });
    const value = JSON.parse(json) as ExplorationPayload;
    for (const family of publication.fragments.filter(family => family.name !== 'main')) {
        assert.ok(seen.includes(family.target));
        assert.equal(value.families[family.target].href, 'https://cap.invalid/' + family.target);
    }
    const inactive = JSON.parse(explorationPayload(publication, 'index.literate', 'preview')) as ExplorationPayload;
    assert.equal(inactive.families[publication.fragments.find(family => family.name === 'child')!.target].href, undefined);
    assert.doesNotMatch(json, /vscode:|data-line|tokenIndex|definition/);
    const child = publication.fragments.find(family => family.name === 'child')!.target;
    const main = publication.contributions.find(part => part.definition.path === 'index.literate')!;
    assert.doesNotMatch(renderScreenCode(main, publication, 'preview'), /<a /);
    assert.match(renderScreenCode(main, publication, 'preview', target => 'https://cap.invalid/' + target), /href="https:\/\/cap.invalid\//);
    assert.doesNotMatch(renderScreenExploration(publication, 'index.literate', 'preview'), /<script>/);
    const f = browser(value, [child]); f.buttons()[0].click();
    assert.equal(f.panels()[0].querySelectorAll('a').length, 0, 'payload-only HTTPS is not an authenticated capability');
    const leaf = publication.fragments.find(family => family.name === 'leaf')!.target;
    const baseline = f.document.createElement('a');
    baseline.setAttribute('data-literate-target', leaf); baseline.setAttribute('href', value.families[leaf].href!);
    f.root.append(baseline); f.document.notify(); f.buttons()[0].click();
    assert.equal(f.panels()[0].querySelector('a')!.getAttribute('href'), value.families[leaf].href);
    const pending = browser(inactive, [child]); pending.buttons()[0].click();
    assert.equal(pending.panels()[0].querySelectorAll('a').length, 0);
});

test('payload cap rejects entire code, escapes HTML-sensitive JSON, and caches neutral segments', () => {
    const publication = model();
    explorationPayload(publication, 'index.literate', 'html');
    Object.defineProperty(publication.contributions[0], 'segments', { get: () => assert.fail('must reuse cached segments') });
    explorationPayload(publication, 'nested/defs.literate', 'html');
    const huge = parseProject([{ path: 'index.literate', text: fence('huge', 'x'.repeat(explorationLimits.payload)) }]).publication;
    const json = explorationPayload(huge, 'index.literate', 'html');
    assert.ok(Buffer.byteLength(json) <= explorationLimits.payload);
    assert.match(JSON.parse(json).unavailable, /one MiB/);
    assert.deepEqual(JSON.parse(json).parts, {});
    const text = '</script>&\u2028\u2029';
    assert.doesNotMatch(serializeExploration({ text }), /[<>&\u2028\u2029]/);
    assert.equal(JSON.parse(serializeExploration({ text })).text, text);
});

// Small DOM contract fixture: no HTML setters, browser keyboard emulation or network.
class Node {
    children: Node[] = [];
    parent?: Node;
    attributes = new Map<string, string>();
    style: Record<string, string> = {};
    listeners = new Map<string, () => void>();
    type = '';
    private text = '';
    constructor(readonly tag: string, readonly owner: Dom) {}
    set id(value: string) { this.setAttribute('id', value); }
    get id() { return this.getAttribute('id') || ''; }
    set textContent(value: string) { for (const child of [...this.children]) { child.remove(); } this.text = value; }
    get parentNode() { return this.parent; }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    after(...nodes: Node[]) {
        const parent = this.parent!;
        nodes.forEach(node => { node.parent = parent; });
        parent.children.splice(parent.children.indexOf(this) + 1, 0, ...nodes);
    }
    get previousSibling() { return this.parent?.children[this.parent.children.indexOf(this) - 1]; }
    remove() {
        if (this.contains(this.owner.activeElement)) { this.owner.activeElement = this.owner.body; }
        if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
    }
    contains(node: Node | undefined): boolean { return node === this || this.children.some(child => child.contains(node)); }
    focus() { this.owner.activeElement = this; this.owner.events.get('focusin')?.({ target: this }); }
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    click() { this.listeners.get('click')?.(); }
    matches(selector: string): boolean {
        if (selector === '.literate-document') { return this.getAttribute('class') === 'literate-document'; }
        if (selector.startsWith('script.')) { return this.tag === 'script'; }
        if (selector.startsWith('[')) { return this.attributes.has(selector.slice(1, -1)); }
        return this.tag === selector;
    }
    querySelectorAll(selector: string): Node[] {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
    get outerHTML(): string {
        const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return '<' + this.tag + [...this.attributes].map(([key, value]) => ` ${key}="${escape(value)}"`).join('') + '>'
            + escape(this.text) + this.children.map(child => child.outerHTML).join('') + '</' + this.tag + '>';
    }
}
class Dom {
    activeElement?: Node;
    documentElement = new Node('html', this);
    body = new Node('body', this);
    created = 0;
    observed?: { attributes: boolean; attributeFilter: string[]; characterData: boolean };
    events = new Map<string, (event?: { target: Node }) => void>();
    notify = () => {};
    defaultView = {
        TextEncoder, URL,
        addEventListener: (name: string, callback: () => void) => this.events.set(name, callback),
        MutationObserver: class {
            constructor(callback: () => void) { domForObserver.notify = callback; }
            observe(_node: unknown, options: Dom['observed']) { domForObserver.observed = options; }
        }
    };
    createElement(tag: string) { this.created++; return new Node(tag, this); }
    querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
    getElementById(id: string) { return this.querySelectorAll('[id]').find(node => node.id === id); }
    addEventListener(name: string, callback: (event?: { target: Node }) => void) { this.events.set(name, callback); }
}
let domForObserver: Dom;
function browser(value: ExplorationPayload, uses = ['a'], script = explorationBrowserScript()) {
    const document = new Dom(); domForObserver = document;
    const root = document.createElement('div'); root.setAttribute('class', 'literate-document');
    document.documentElement.append(root);
    const baseline = uses.map(target => {
        const use = document.createElement('span'); use.setAttribute('data-literate-explore', target);
        const link = document.createElement('a'); link.setAttribute('href', '#' + target);
        link.setAttribute('data-literate-target', target); link.textContent = '<<' + target + '>>';
        use.append(link); root.append(use); return link;
    });
    const payload = document.createElement('script'); payload.textContent = serializeExploration(value); root.append(payload);
    vm.runInNewContext(script, { document });
    return { document, root, baseline, buttons: () => root.querySelectorAll('button'),
        panels: () => root.querySelectorAll('button').map(button => document.getElementById(button.getAttribute('aria-controls') || ''))
            .filter((node): node is Node => !!node) };
}
function chain(count: number, cycle = false): ExplorationPayload {
    const value: ExplorationPayload = { version: 1, families: {}, parts: {} };
    for (let index = 0; index < count; index++) {
        const id = index ? 'a' + index : 'a';
        value.families[id] = { name: id, parts: [id], href: '#' + id };
        value.parts[id] = [{ text: '<literal> & ' }, ...(index + 1 < count || cycle
            ? [{ text: 'reference', reference: true as const, target: index + 1 < count ? 'a' + (index + 1) : 'a' }] : [])];
    }
    return value;
}

const nativeCapability = 'vscode://jesterking.literate/navigate/' + 'a'.repeat(48) + '/' + 'b'.repeat(48);

test('forged payload URLs and malformed native capabilities remain literal references', () => {
    const unsafe = [
        'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
        'command:workbench.action.openSettings', 'file:///tmp/defs.html#a1',
        'https://cap.invalid/a1', '//cap.invalid/defs.html#a1',
        './defs.html#wrong', '#wrong', './defs.html?redirect=1#a1',
        './defs.html#a1\n', './de\\fs.html#a1', './de\u0000fs.html#a1',
        nativeCapability.replace('jesterking.literate', 'attacker.invalid'),
        nativeCapability.replace('jesterking.literate', 'jesterking.literate.attacker.invalid'),
        nativeCapability.replace('jesterking.literate', 'user@jesterking.literate'),
        nativeCapability.replace('jesterking.literate', 'jesterking.literate:123'),
        nativeCapability.replace('/navigate/', '/other/'),
        nativeCapability.slice(0, -1), nativeCapability + 'b', nativeCapability + '/extra',
        nativeCapability.replace('/navigate/', '/navigate/%61'),
        nativeCapability + '#a1', nativeCapability + '?windowId=1#a1',
        nativeCapability + '?windowId=1\n', nativeCapability + '?path=\\evil',
        nativeCapability.replace('vscode:', 'vscode-other:')
    ];
    for (const href of unsafe) {
        const value = chain(2); value.families.a1.href = href;
        const f = browser(value); const baseline = f.baseline[0].outerHTML;
        f.buttons()[0].click();
        assert.equal(f.panels().length, 1, href);
        assert.equal(f.panels()[0].querySelectorAll('a').length, 0, href);
        assert.match(f.panels()[0].textContent, /reference/, href);
        assert.equal(f.buttons().length, 2, 'unsafe destinations retain exploration');
        assert.equal(f.baseline[0].outerHTML, baseline, 'ordinary links are not rewritten');
    }
});

test('semantic local links and exact native capabilities preserve host query suffixes', () => {
    for (const href of ['#a1', './nested/defs.html#a1', './nested/a%20b.html#a1',
        nativeCapability, nativeCapability + '?',
        nativeCapability + '?windowId=12&state=a%2Fb%3Fc%23d',
        nativeCapability.replace('vscode:', 'vscode-insiders:') + '?windowId=_blank']) {
        const value = chain(2); value.families.a1.href = href;
        const f = browser(value); f.buttons()[0].click();
        assert.equal(f.panels()[0].querySelector('a')?.getAttribute('href'), href);
        assert.equal(f.panels()[0].querySelector('a')?.getAttribute('data-literate-target'), 'a1');
    }
});

test('baseline authority rejects unsafe or conflicting links without payload fallback', () => {
    for (const hrefs of [
        ['javascript:alert(1)'], ['https://user:password@cap.invalid/a1'],
        [nativeCapability + '#fragment'],
        ['#a1', './defs.html#a1', '#a1'],
        ['https://cap.invalid/first', 'https://cap.invalid/second', 'https://cap.invalid/first']
    ]) {
        const f = browser(chain(2));
        for (const href of hrefs) {
            const anchor = f.document.createElement('a');
            anchor.setAttribute('data-literate-target', 'a1'); anchor.setAttribute('href', href);
            f.root.append(anchor);
        }
        f.document.notify(); f.buttons()[0].click();
        assert.equal(f.panels()[0].querySelectorAll('a').length, 0, JSON.stringify(hrefs));
    }
    for (const href of ['https://cap.invalid/opaque?state=1', nativeCapability + '?windowId=2']) {
        const value = chain(2); value.families.a1.href = 'javascript:alert(1)';
        const f = browser(value);
        const anchor = f.document.createElement('a');
        anchor.setAttribute('data-literate-target', 'a1'); anchor.setAttribute('href', href); f.root.append(anchor);
        f.document.notify(); f.buttons()[0].click();
        assert.equal(f.panels()[0].querySelector('a')?.getAttribute('href'), href);
    }
});

test('oversized and repeated contributions reject the whole plan before any DOM allocation', () => {
    const cases: [string, (value: ExplorationPayload) => void][] = [
        ['oversized text', value => { value.parts.a = [{ text: 'x'.repeat(explorationLimits.bytes + 1) }]; }],
        ['escaped text budget', value => { value.parts.a = [{ text: '&'.repeat(60000) }]; }],
        ['UTF-8 text budget', value => { value.parts.a = [{ text: '\u754c'.repeat(90000) }]; }],
        ['too many parts', value => {
            value.families.a.parts = Array.from({ length: explorationLimits.parts + 1 }, (_, index) => 'p' + index);
            for (const id of value.families.a.parts) { value.parts[id] = []; }
        }],
        ['repeated part', value => { value.families.a.parts = ['a', 'a']; }],
        ['too many repeated segments', value => {
            value.parts.a = Array(explorationLimits.segments + 1).fill({ text: '' });
        }],
        ['aggregate segment limit', value => {
            value.families.a.parts = ['a', 'b'];
            value.parts.a = Array(explorationLimits.segments / 2).fill({ text: '' });
            value.parts.b = Array(explorationLimits.segments / 2 + 1).fill({ text: '' });
        }],
        ['late oversized contribution', value => {
            value.families.a.parts = ['a', 'b']; value.parts.b = [{ text: 'x'.repeat(explorationLimits.bytes) }];
        }]
    ];
    for (const [label, mutate] of cases) {
        const value = chain(1); mutate(value);
        assert.ok(Buffer.byteLength(serializeExploration(value)) < explorationLimits.payload, label);
        const f = browser(value); const created = f.document.created;
        const baseline = f.baseline[0].outerHTML;
        f.buttons()[0].click();
        assert.equal(f.document.created, created, label + ': no candidate DOM');
        assert.equal(f.panels().length, 0, label);
        assert.equal(f.buttons()[0].getAttribute('aria-expanded'), 'false', label);
        assert.match(f.root.textContent, /DOM budget or contribution limit/, label);
        assert.equal(f.baseline[0].outerHTML, baseline, label);
    }
});

test('NaN and negative DOM accounting metadata cannot poison capacity or panel ownership', () => {
    for (const metadata of ['NaN', '-999999999']) {
        for (const detach of [false, true]) {
            const value = chain(1); value.parts.a = [{ text: 'x'.repeat(140000) }];
            const f = browser(value, ['a', 'a']); const buttons = f.buttons();
            buttons[0].click();
            f.panels()[0].setAttribute('data-literate-panel-bytes', metadata);
            const created = f.document.created;
            buttons[1].click();
            assert.equal(f.document.created, created, 'metadata cannot create spare capacity');
            assert.equal(f.panels().length, 1);
            if (detach) { f.panels()[0].remove(); f.document.notify(); } else { buttons[0].click(); }
            buttons[1].click();
            assert.equal(f.panels().length, 1, 'private charge is released exactly once');
            buttons[0].click();
            assert.equal(f.panels().length, 1, 'refund neither poisons nor inflates the remaining budget');
        }
        const f = browser(chain(3)); f.buttons()[0].click();
        f.panels()[0].setAttribute('data-literate-panel-bytes', metadata);
        f.document.notify(); f.buttons()[1].click();
        assert.equal(f.panels().length, 2, 'owned panel references never become baseline uses');
    }
});

test('browser lazily opens bounded layers, preserves IDs/links, and restores focus on collapse', () => {
    const f = browser(chain(20));
    const baseline = f.baseline[0].outerHTML;
    const occupied = f.document.createElement('span'); occupied.id = 'literate-exploration-1'; f.root.append(occupied);
    assert.equal(f.panels().length, 0);
    for (let index = 0; index < 8; index++) { f.buttons()[index].click(); }
    assert.equal(f.panels().length, 8);
    f.buttons()[8].click();
    assert.match(f.root.textContent, /eight layers/);
    assert.equal(f.buttons()[8].getAttribute('aria-expanded'), 'false');
    assert.equal(f.baseline[0].outerHTML, baseline);
    const ids = f.root.querySelectorAll('[id]').map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.doesNotMatch(f.panels()[0].outerHTML, /data-line|code-line|source-map|<literal>/);
    assert.equal(f.buttons()[0].type, 'button');
    assert.deepEqual([...f.buttons()[0].listeners.keys()], ['click'], 'native Enter/Space activation is not overridden');
    f.buttons()[8].focus(); f.buttons()[0].click();
    assert.equal(f.document.activeElement, f.buttons()[0]);
    assert.equal(f.panels().length, 0);
    assert.equal(f.buttons()[0].getAttribute('aria-expanded'), 'false');
    f.document.notify();
    assert.equal(f.buttons().length, 1, 'updates do not duplicate controls');
});

test('cycles are path-local; repeated uses stay independent; missing references are explained', () => {
    const f = browser(chain(2, true), ['a', 'a']);
    const original = f.buttons(); original[0].click(); f.buttons()[1].click(); f.buttons()[2].click();
    assert.match(f.root.textContent, /Cycle/);
    original[1].click(); assert.equal(f.panels().length, 3);
    original[0].click(); assert.equal(f.panels().length, 1);
    const missing = browser(chain(1), ['missing']); missing.buttons()[0].click();
    assert.match(missing.root.textContent, /unavailable/);
    assert.equal(missing.panels().length, 0);
});

test('DOM and panel caps reject whole views and release capacity on collapse', () => {
    const value = chain(1); value.parts.a = [{ text: 'x'.repeat(140000) }];
    const f = browser(value, ['a', 'a']);
    const buttons = f.buttons(); buttons[0].click(); buttons[1].click();
    assert.equal(f.panels().length, 1);
    assert.match(f.root.textContent, /DOM budget/);
    buttons[0].click(); buttons[1].click(); assert.equal(f.panels().length, 1);
    assert.equal(f.panels()[0].textContent.includes('x'.repeat(140000)), true);
    const many = browser(chain(1), Array(201).fill('a'));
    const controls = many.buttons(); controls.forEach(button => button.click());
    assert.equal(many.panels().length, 200);
    assert.match(many.root.textContent, /panel limit/);
    controls[0].click(); controls[200].click(); assert.equal(many.panels().length, 200);
});

test('preview DOM reuse replaces stale data and restores controls removed by the host', () => {
    const f = browser(chain(1)); f.buttons()[0].click();
    const replacement = chain(1); replacement.parts.a = [{ text: 'fresh buffer' }];
    f.root.querySelector('script')!.textContent = serializeExploration(replacement);
    f.document.notify();
    assert.equal(f.panels().length, 0);
    assert.equal(f.buttons().length, 1);
    f.buttons()[0].click(); assert.match(f.panels()[0].textContent, /fresh buffer/);
    f.buttons()[0].remove(); f.document.notify();
    assert.equal(f.buttons().length, 1);
    assert.equal(f.panels().length, 0);
});

test('unavailable payloads keep fallback links and explain why exploration cannot open', () => {
    const f = browser({ version: 1, parts: {}, families: {}, unavailable: 'Payload limit reached.' });
    f.buttons()[0].click();
    assert.match(f.root.textContent, /unavailable/);
    assert.equal(f.baseline[0].getAttribute('href'), '#a');
    assert.equal(f.panels().length, 0);
});

test('shared append contributions stay unexpanded and in model order', () => {
    const documents = sources();
    documents[1].text += '```text : <<child>>=+\nlast <<leaf>>\n```\n';
    const publication = parseProject(documents).publication;
    const family = publication.fragments.find(value => value.name === 'child')!;
    const value = JSON.parse(explorationPayload(publication, 'index.literate', 'html')) as ExplorationPayload;
    assert.deepEqual(value.families[family.target].parts, family.contributions);
    const f = browser(value, [family.target]); f.buttons()[0].click();
    assert.match(f.panels()[0].textContent, /last <<leaf>>/);
    assert.doesNotMatch(f.panels()[0].textContent, /leaf body/);
});

function exportedInitializer(source: string): string {
    const module: { exports: { initializePublicationExploration?: Function } } = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.equal(typeof module.exports.initializePublicationExploration, 'function');
    return '(' + module.exports.initializePublicationExploration!.toString()
        .replace(/<\/script/gi, '<\\/script') + ')(document);';
}
function clientTrace(script: string) {
    assert.doesNotMatch(script, /<\/script/i);
    const f = browser(chain(2, true), ['a', 'a'], script);
    const states: string[] = [];
    const capture = () => states.push(f.root.outerHTML);
    capture();
    const controls = f.buttons();
    controls[0].click(); capture();
    f.buttons()[1].click(); capture();
    f.buttons()[2].click(); capture();
    assert.match(f.root.textContent, /Cycle/);
    controls[1].click(); capture();
    f.buttons()[2].focus(); controls[0].click(); capture();
    assert.equal(f.document.activeElement, controls[0]);
    f.document.notify(); capture();
    const deep = browser(chain(20), ['a'], script);
    for (let index = 0; index <= 8; index++) { deep.buttons()[index].click(); }
    assert.equal(deep.panels().length, 8);
    assert.match(deep.root.textContent, /eight layers/);
    states.push(deep.root.outerHTML);
    return states;
}
const browserSourcePath = path.resolve(__dirname, '../../../src/publication-exploration-browser.js');
const browserCommonJsPath = path.resolve(__dirname, '../../../out/publication-exploration-browser.js');
const browserPreviewPath = path.resolve(__dirname, '../../../out/publication-exploration-preview.js');

test('standalone and source browser entry have functional parity without outer scope dependencies', () => {
    const source = fs.readFileSync(browserSourcePath, 'utf8');
    const expected = clientTrace(exportedInitializer(source));
    assert.deepEqual(clientTrace(explorationBrowserScript()), expected);
    assert.deepEqual(clientTrace(source), expected);
    assert.doesNotMatch(source, /innerHTML\s*=|insertAdjacentHTML|fetch\(|clipboard|execCommand/);
});

test('shipped CommonJS initializer has functional parity without outer scope dependencies',
    { skip: !fs.existsSync(browserCommonJsPath) }, () => {
        const expected = clientTrace(exportedInitializer(fs.readFileSync(browserSourcePath, 'utf8')));
        // Invoke only toString() in a fresh realm: CJS helpers cannot leak into the embedded client.
        assert.deepEqual(clientTrace(exportedInitializer(fs.readFileSync(browserCommonJsPath, 'utf8'))), expected);
    });

test('shipped preview IIFE has functional parity in an isolated browser realm',
    { skip: !fs.existsSync(browserPreviewPath) }, () => {
        const expected = clientTrace(exportedInitializer(fs.readFileSync(browserSourcePath, 'utf8')));
        assert.deepEqual(clientTrace(fs.readFileSync(browserPreviewPath, 'utf8')), expected);
    });
