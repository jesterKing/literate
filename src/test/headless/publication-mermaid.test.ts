import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { renderDiagrams, validateDiagram, executeDiagramWorker, DiagramRenderer, diagramLimits } from '../../publication-mermaid';
import { collectAssets, planAssets } from '../../publication-assets';
import { parseProject } from '../../engine';
import { createTransactionIO, run } from '../../cli';
import { PublicationAsset } from '../../publication-pandoc';

const worker = require('../../publication-mermaid-worker.mjs');
const source = 'flowchart TD\nA[Write] --> B[Publish]';
const asset = (text = source, line = 2): PublicationAsset => ({
    kind: 'mermaid', source: text, caption: '', at: { path: 'chapter.literate', line, column: 0 }
});
const bytes = { pdf: Buffer.from('%PDF-1.4\n'), svg: Buffer.from('<svg/>') };
const renderer: DiagramRenderer = async assets => new Map(assets.map(asset => [asset.source, bytes]));
const fence = (text = source) => '\n```mermaid\n' + text + '\n```\n';
function fixture(t: { after(callback: () => void): void }): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'literate mermaid test '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function write(directory: string, name: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
}
function tree(directory: string): unknown {
    return fs.readdirSync(directory).sort().map(name => {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        return [name, stat.isDirectory() ? tree(file) : [stat.mtimeMs, stat.mode, fs.readFileSync(file).toString('hex')]];
    });
}
for (const value of ['', 'x'.repeat(50001), '%%{init:{}}%%\ngraph TD;A-->B', '---\ntheme: dark\n---\ngraph TD',
    'graph TD; style A fill:red', 'graph TD\nclassDef evil fill:url(https://example.org/a)',
    'graph TD\nclick A "https://example.org"', 'sequenceDiagram\nlinks Alice: {"x":"file:///etc/passwd"}',
    'graph TD\nA[<img src="file:///etc/passwd">]', 'graph TD classDef default fill:red',
        'flowchart TD\nA[&lt;style&gt;body{}]']) {
    test(`Mermaid source rejects configuration/resources: ${value.slice(0, 70)}`, () => {
        assert.throws(() => validateDiagram(value));
    });
}
for (const text of ['flowchart TD\nA["Click here"] --> B["Link records"]',
    'sequenceDiagram\nAlice->>Bob: "link the records"', 'flowchart TD\n%% style guide\nA --> B']) {
    test(`quoted labels and comments are not commands: ${text}`, () => validateDiagram(text));
}
for (const text of ['flowchart TD\nA["Click here"]; click A "https://example.org"',
    'flowchart TD\nA["unfinished\nclick A "https://example.org"',
    'flowchart TD\nA["escaped \\" label"]; style A fill:red',
    'flowchart TD\nA["<img src=x>"]']) {
    test(`label masking cannot hide forbidden content: ${text}`, () => assert.throws(() => validateDiagram(text)));
}
test('ordinary nested Mermaid fences collect source and location without rendering', () => {
    const result = collectAssets(parseProject([{ path: 'chapter.literate', text: '# Book\n\n> ' + fence().trim().split('\n').join('\n> ') }]));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.assets.length, 1); assert.equal(result.assets[0].kind, 'mermaid');
    assert.equal(result.assets[0].source.trim(), source); assert.equal(result.assets[0].at.line, 2);
});
test('diagram planner retains PDF and SVG once, resolves every occurrence and protects local files', async () => {
    const requests = [asset(), asset(source, 10), { ...asset('a.pdf'), kind: 'image' as const }];
    const result = await planAssets(requests, 'book/book.tex', {
        async requireFile() {}, async read() { return bytes.pdf; }
    }, assets => renderer(assets, 'rosepine-dawn'));
    assert.equal(result.files.length, 2); // PDF content also deduplicates against the local PDF.
    assert.deepEqual(result.inputs, ['a.pdf']); assert.equal(result.paths.size, 2);
    assert.ok(result.files.some(file => file.path.endsWith('.svg')));
});
test('no diagram means no executable lookup, worker call or browser requirement', async () => {
    assert.deepEqual(await renderDiagrams([], 'invalid', undefined, async () => assert.fail()), new Map());
});
test('missing browser, nonexistent executable, invalid theme and request limits fail before the worker', async () => {
    const worker = async () => assert.fail('worker must not start');
    await assert.rejects(renderDiagrams([asset()], 'rosepine-dawn', undefined, worker), /--browser.*No browser is downloaded/);
    await assert.rejects(renderDiagrams([asset()], 'rosepine-dawn', '/nonexistent/literate-chromium', worker), /Cannot execute/);
    await assert.rejects(renderDiagrams([asset()], 'invalid', process.execPath, worker), /Unknown.*theme/);
    await assert.rejects(renderDiagrams(Array.from({ length: diagramLimits.count + 1 }, (_, i) => asset(source + i)),
        'rosepine-dawn', process.execPath, worker), new RegExp(`${diagramLimits.count} unique`));
    await assert.rejects(renderDiagrams([asset('%%{init:{}}%%')], 'rosepine-dawn', process.execPath, worker), /chapter.literate:3/);
});
test('latched cancellation is checked at entry, even without diagrams', async () => {
    const cancellation = new Error('publication interrupted');
    const checkCancelled = (): void => { throw cancellation; };
    for (const assets of [[], [asset()]]) {
        await assert.rejects(renderDiagrams(assets, 'invalid', undefined,
            async () => assert.fail('worker must not start'), checkCancelled), error => error === cancellation);
    }
});
for (const stage of ['stat', 'access', 'mkdtemp', 'writeFile', 'worker', 'lstat', 'readFile']) {
    test(`persistent cancellation after ${stage} stops rendering and cleans temporary files`, () => {
        // Filesystem hooks live in a child process, never in another test's module cache.
        execFileSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const promises = require('node:fs/promises');
            const path = require('node:path');
            const { renderDiagrams } = require(process.argv[1]);
            const stage = process.argv[2];
            const cancellation = new Error('publication interrupted');
            let cancelled = false, scratch = '', workers = 0;
            const calls = [];
            for (const name of ['stat', 'access', 'mkdtemp', 'writeFile', 'lstat', 'readFile']) {
                const original = promises[name];
                promises[name] = async (...args) => {
                    calls.push(name);
                    const result = await original(...args);
                    if (name === 'mkdtemp') { scratch = result; }
                    if (name === stage) { cancelled = true; }
                    return result;
                };
            }
            const asset = ${JSON.stringify(asset())};
            (async () => {
                try {
                    await assert.rejects(renderDiagrams([asset], 'rosepine-dawn', process.execPath,
                        async directory => {
                            workers++;
                            assert.equal(cancelled, false, 'cancelled preparation must not spawn a worker');
                            calls.push('worker');
                            fs.writeFileSync(path.join(directory, '0.pdf'), '%PDF-1.4');
                            fs.writeFileSync(path.join(directory, '0.svg'), '<svg/>');
                            if (stage === 'worker') { cancelled = true; }
                        }, () => { if (cancelled) { throw cancellation; } }), error => error === cancellation);
                    const steps = ['stat', 'access', 'mkdtemp', 'writeFile', 'worker', 'lstat', 'readFile'];
                    assert.deepEqual(calls, steps.slice(0, steps.indexOf(stage) + 1));
                    assert.equal(workers, steps.indexOf(stage) >= steps.indexOf('worker') ? 1 : 0);
                    assert.equal(Boolean(scratch), steps.indexOf(stage) >= steps.indexOf('mkdtemp'));
                    if (scratch) { assert.equal(fs.existsSync(scratch), false, 'temporary directory must be removed'); }
                } finally {
                    if (scratch) { fs.rmSync(scratch, { recursive: true, force: true }); }
                }
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `, require.resolve('../../publication-mermaid'), stage], { timeout: 10000, encoding: 'utf8' });
    });
}
for (const mode of ['success', 'worker-failure', 'missing', 'symlink', 'oversized', 'signature']) {
    test(`controller cleans its private directory on ${mode}`, async () => {
        let scratch = '', calls = 0;
        const promise = renderDiagrams([asset(), asset(source, 10)], 'rosepine-dawn', process.execPath, async directory => {
            scratch = directory; calls++;
            assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
            const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
            assert.deepEqual(request.sources, [source]);
            if (mode === 'worker-failure') { throw new Error('Diagram 1: injected browser failure'); }
            write(directory, '0.pdf', mode === 'signature' ? 'wrong' : bytes.pdf);
            if (mode !== 'missing') { write(directory, '0.svg', bytes.svg); }
            if (mode === 'symlink') { fs.unlinkSync(path.join(directory, '0.svg')); fs.symlinkSync('0.pdf', path.join(directory, '0.svg')); }
            if (mode === 'oversized') { fs.truncateSync(path.join(directory, '0.pdf'), 16 * 1024 * 1024 + 1); }
        });
        if (mode === 'success') { assert.equal((await promise).size, 1); }
        else { await assert.rejects(promise, mode === 'worker-failure' ? /chapter.literate:3.*injected/ : /artifact|ENOENT/); }
        assert.equal(calls, 1); assert.equal(fs.existsSync(scratch), false);
    });
}
for (const [mode, script, error] of [
    ['exit', 'process.stderr.write("injected launch failure");process.exitCode=7;', /exited 7.*injected/],
    ['timeout', 'setInterval(()=>{},1000);', /deadline exceeded/],
    ['log limit', 'process.stderr.write("x".repeat(70000));setInterval(()=>{},1000);', /64 KiB/],
    ['missing script', undefined, /exited 1/]
] as const) {
    test(`worker process ${mode} is bounded and actionable`, async t => {
        const directory = fixture(t), scriptPath = path.join(directory, 'worker.mjs');
        if (script) { write(directory, 'worker.mjs', script); }
        await assert.rejects(executeDiagramWorker(directory, process.execPath, scriptPath, 300), error);
    });
}
test('worker deadline kills a browser-like descendant in the owned process group', { skip: process.platform !== 'linux' }, async t => {
    const directory = fixture(t), scriptPath = path.join(directory, 'worker.mjs');
    write(directory, 'worker.mjs', 'import {spawn} from "node:child_process";import fs from "node:fs";'
        + 'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:false});'
        + 'fs.writeFileSync(process.argv[2]+"/pid",String(child.pid));setInterval(()=>{},1000);');
    await assert.rejects(executeDiagramWorker(directory, process.execPath, scriptPath, 500), /deadline/);
    const pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const stat = `/proc/${pid}/stat`;
    assert.ok(!fs.existsSync(stat) || /^\d+ \(.*\) Z /.test(fs.readFileSync(stat, 'utf8')), 'descendant must be gone or awaiting reaping');
});
test('page isolation aborts every request and records navigation/popups; CSP denies resources', async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    let html = '', aborted = false, closed = false;
    const frame = {};
    const page = { setDefaultTimeout: (value: number) => assert.equal(value, 15000),
        async setRequestInterception(value: boolean) { assert.equal(value, true); },
        on(name: string, callback: (...args: unknown[]) => void) { handlers[name] = callback; },
        async setBypassServiceWorker(value: boolean) { assert.equal(value, true); },
        mainFrame: () => frame,
        async goto(url: string) { handlers.request({ url: () => url, isNavigationRequest: () => true,
            frame: () => frame, async respond(options: { headers: Record<string, string> }) {
                html = options.headers['Content-Security-Policy'];
            } }); }, async evaluate() {} };
    const violations = await worker.isolatePage(page);
    for (const directive of ['default-src', 'connect-src', 'img-src', 'font-src', 'frame-src', 'object-src', 'base-uri', 'form-action']) {
        assert.ok(html.includes(`${directive} 'none'`), directive);
    }
    handlers.request({ url: () => 'https://untrusted.invalid/', async abort() { aborted = true; } });
    handlers.framenavigated({ url: () => 'file:///etc/passwd' });
    handlers.popup({ async close() { closed = true; } });
    assert.equal(aborted, true); assert.equal(closed, true); assert.equal(violations.length, 3);
});
function svgDocument(attributes: { name: string; value: string }[] = [], forbidden = false, width = 400) {
    const svg = { attributes, querySelector: () => forbidden ? {} : null, querySelectorAll: () => [],
        getBBox: () => ({ x: 0, y: 0, width, height: 200 }), viewBox: { baseVal: { x: 0, y: 0, width, height: 200 } },
        setAttribute() {}, prepend() {}, style: {}, outerHTML: '<svg/>' };
    return { querySelector: () => svg, createElementNS: () => ({ textContent: '' }) };
}
for (const [name, document] of [
    ['active SVG', svgDocument([], true)], ['handler', svgDocument([{ name: 'onclick', value: 'evil()' }])],
    ['external href', svgDocument([{ name: 'href', value: 'file:///etc/passwd' }])],
    ['CSS URL', svgDocument([{ name: 'style', value: 'fill:url(https://example.org)' }])],
    ['CSS import', svgDocument([{ name: 'style', value: '@import "x"' }])],
    ['geometry', svgDocument([], false, 20000)]
] as const) {
    test(`SVG policy rejects ${name} before printing`, () => {
        assert.throws(() => runInNewContext(`(${worker.measureSvg.toString()})()`, { document }));
    });
}
test('SVG policy allows only local fragment references and pads measured bounds', () => {
    const result = runInNewContext(`(${worker.measureSvg.toString()})()`, {
        document: svgDocument([{ name: 'style', value: 'fill:url(#marker)' }])
    });
    assert.equal(result.width, 416); assert.equal(result.height, 216);
});
test('renderer closes contexts on invalid diagrams and surfaces close failure', async () => {
    for (const closeFails of [false, true]) {
        let closed = 0;
        const page = { setDefaultTimeout() {}, async setRequestInterception() {}, on() {},
            async setBypassServiceWorker() {}, async goto() {}, async evaluate() { throw new Error('invalid diagram'); },
            async setViewport() {} };
        const browser = { async createBrowserContext() { return { async newPage() { return page; }, async close() {
            closed++; if (closeFails) { throw new Error('context close failed'); }
        } }; } };
        await assert.rejects(worker.renderVector(browser, source, 'rosepine-dawn', ''), closeFails ? /context close failed/ : /invalid diagram/);
        assert.equal(closed, 1);
    }
});
test('owned launcher awaits Puppeteer arguments and rejects a missing private profile before spawning', async () => {
    let called = false;
    await assert.rejects(worker.connectOwnedBrowser({ async defaultArgs() { called = true; return []; } },
        { executablePath: process.execPath, args: [], userDataDir: '/private/profile' }), /isolated browser arguments/);
    assert.equal(called, true);
});
test('owned launcher reports spawn failure without leaking an endpoint timer', async () => {
    await assert.rejects(worker.connectOwnedBrowser({ async defaultArgs() { return ['--user-data-dir=/private/profile']; } },
        { executablePath: '/missing/chromium', args: [], userDataDir: '/private/profile' }), /ENOENT/);
});
test('launch adapter gets only fixed sandbox-enabled options and closes the browser on render failure', async t => {
    const directory = fixture(t); let closed = 0;
    write(directory, 'request.json', JSON.stringify({ sources: [source], theme: 'rosepine-dawn' }));
    await assert.rejects(worker.browserBatch(directory, '/explicit/chromium', async (options: { executablePath: string; args: string[]; userDataDir: string }) => {
        assert.equal(options.executablePath, '/explicit/chromium');
        assert.equal(options.userDataDir, path.join(directory, 'profile'));
        assert.ok(options.args.includes('--js-flags=--max-old-space-size=256'));
        assert.ok(options.args.every(arg => !arg.includes('no-sandbox') && !arg.includes('disable-web-security')));
        return { async createBrowserContext() { throw new Error('render failed'); }, async close() { closed++; } };
    }), /Diagram 1.*render failed/);
    assert.equal(closed, 1);
});
async function cli(root: string, render = renderer, factory = createTransactionIO, args: string[] = []) {
    let stdout = '', conversions = 0;
    const code = await run(['latex', root, '--output', 'books/book.tex', '--json', ...args], {
        stdout: value => { stdout += value; }, stderr: value => assert.fail(value)
    }, factory, async () => { conversions++; return 'book body'; }, render);
    return { code, conversions, response: JSON.parse(stdout) };
}
test('CLI does not invoke a browser adapter without diagrams, even with a nonexistent explicit executable', async t => {
    const root = fixture(t); write(root, 'index.literate', '# Book');
    assert.equal((await cli(root, async () => assert.fail(), undefined, ['--browser', '/missing/chromium'])).code, 0);
});
for (const error of ['invalid diagram', 'blocked network request', 'spawn failed', 'deadline exceeded', 'browser close failed']) {
    test(`CLI browser failure preserves every existing output: ${error}`, async t => {
        const root = fixture(t); write(root, 'index.literate', '# Book\n' + fence());
        assert.equal((await cli(root)).code, 0);
        const before = tree(root);
        const result = await cli(root, async () => { throw new Error(error); });
        assert.equal(result.code, 1); assert.equal(result.conversions, 0);
        assert.match(result.response.errors.join('\n'), new RegExp(error));
        assert.deepEqual(tree(root), before);
    });
}
test('CLI PDF and SVG join text in the rollback transaction', async t => {
    const root = fixture(t); write(root, 'index.literate', '# Book\n' + fence());
    const first = await cli(root); assert.equal(first.code, 0);
    for (const output of first.response.outputs) { write(root, output.path, 'old'); }
    const before = tree(root); let injected = false;
    const result = await cli(root, renderer, directory => {
        const io = createTransactionIO(directory);
        return { ...io, async rename(from, to) {
            await io.rename(from, to);
            if (!injected && from.endsWith('.stage') && to.endsWith('.svg')) {
                injected = true; throw new Error('after SVG install');
            }
        } };
    });
    assert.equal(injected, true); assert.equal(result.code, 1);
    assert.match(result.response.errors.join('\n'), /rolled_back/);
    assert.deepEqual(tree(root), before);
});
test('CLI protects source hard-link aliases at generated SVG destinations', async t => {
    const root = fixture(t); write(root, 'index.literate', '# Book\n' + fence());
    const first = await cli(root);
    const svg = first.response.outputs.find((file: { path: string }) => file.path.endsWith('.svg')).path;
    fs.unlinkSync(path.join(root, svg)); fs.linkSync(path.join(root, 'index.literate'), path.join(root, svg));
    const before = tree(root), result = await cli(root);
    assert.equal(result.code, 1); assert.equal(result.conversions, 0);
    assert.match(result.response.errors.join('\n'), /aliases input/);
    assert.deepEqual(tree(root), before);
});
for (const args of [['--browser', 'relative'], ['--browser', '/one', '--browser', '/two']]) {
    test(`CLI rejects invalid browser arguments ${args.join(' ')}`, async t => {
        const root = fixture(t); write(root, 'index.literate', '# Book');
        assert.equal((await cli(root, renderer, undefined, args)).code, 2);
    });
}
