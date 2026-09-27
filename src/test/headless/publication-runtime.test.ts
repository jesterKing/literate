import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(__dirname, '../../..');
const runtime = require(path.join(root, 'src/build-publication.mjs'));
function temporary(t: { after(callback: () => void): void }): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'literate publication runtime '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function graph(inputs: string[] = [], imports: { path: string; kind?: string }[] = []) {
    return { inputs: Object.fromEntries(inputs.map(name => [name, {}])), outputs: { runtime: { imports } } };
}

test('publication graph permits only one closed runtime with Node builtins', () => {
    runtime.assertPublicationGraph(graph(['src/cli.ts'], [{ path: 'node:fs', kind: 'import-statement' }]), 'node');
    runtime.assertPublicationGraph(graph(['publication:self-hosting-disabled']), 'node');
    runtime.assertPublicationGraph(graph(), 'browser');
    for (const name of ['puppeteer-core', 'bufferutil', 'utf-8-validate', 'proxy-agent', 'yauzl', './chunk.js']) {
        assert.throws(() => runtime.assertPublicationGraph(graph([], [{ path: name }]), 'node'), /Unbundled/);
    }
    assert.throws(() => runtime.assertPublicationGraph(graph([], [{ path: 'fs' }]), 'browser'), /Unbundled/);
    assert.throws(() => runtime.assertPublicationGraph(graph([], [{ path: 'fs', kind: 'require-resolve' }]), 'node'), /Unbundled/);
    assert.throws(() => runtime.assertPublicationGraph({ inputs: {}, outputs: {} }, 'node'), /exactly one/);
    assert.throws(() => runtime.assertPublicationGraph({ inputs: {}, outputs: { a: {}, b: {} } }, 'node'), /exactly one/);
});

for (const name of ['node_modules/typescript/lib/typescript.js', 'node_modules/esbuild/lib/main.js',
    'node_modules/webpack/lib/index.js', 'node_modules/puppeteer/lib/index.js',
    'node_modules/@puppeteer/browsers/lib/install.js', 'src/self-hosting.ts', 'src/build-publication.mjs',
    'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
    'node_modules/puppeteer-core/lib/puppeteer/node/ChromeLauncher.js',
    'node_modules/puppeteer-core/lib/puppeteer/node/BrowserLauncher.js',
    'node_modules/puppeteer-core/lib/puppeteer/node/PuppeteerNode.js']) {
    test(`publication graph excludes ${name}`, () => {
        assert.throws(() => runtime.assertPublicationGraph(graph([name]), 'node'), /Forbidden/);
        assert.throws(() => runtime.assertPublicationGraph(graph([name.replace(/\//g, '\\')]), 'node'), /Forbidden/);
    });
}

test('publication validates exact dependency declarations and installed versions', async t => {
    await runtime.validatePublicationVersions(root);
    const directory = temporary(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    manifest.devDependencies['puppeteer-core'] = '^25.12.0';
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(runtime.validatePublicationVersions(directory), /requires puppeteer-core 25\.12\.0/);
    await assert.rejects(runtime.buildPublication({ mode: 'unknown' }), /Unknown publication build mode/);
});

test('launch snapshot refuses unsafe build environment overrides', async () => {
    for (const name of ['PUPPETEER_DANGEROUS_NO_SANDBOX', 'PUPPETEER_TEST_EXPERIMENTAL_CHROME_FEATURES']) {
        const old = process.env[name];
        try {
            process.env[name] = 'true';
            await assert.rejects(runtime.publicationDefaultArgs(), new RegExp(`Unset ${name}`));
        } finally {
            if (old === undefined) { delete process.env[name]; } else { process.env[name] = old; }
        }
    }
    const args = await runtime.publicationDefaultArgs();
    assert.ok(args.includes('--headless=new'));
    assert.ok(!args.some((arg: string) => /^--(?:no-sandbox|user-data-dir|remote-debugging)/.test(arg)));
});

test('connect-only adapter preserves the injected defaultArgs/connect API and fails closed', async t => {
    const directory = temporary(t);
    const outfile = path.join(directory, 'adapter.cjs');
    await build({ entryPoints: [path.join(root, 'src/publication-puppeteer.mjs')], outfile,
        bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
        define: { ['PUBLICATION_CHROMIUM_DEFAULT_ARGS']: JSON.stringify(['--headless=new', 'about:blank']) },
        plugins: [{ name: 'fake-connection', setup(builder) {
            builder.onResolve({ filter: /^puppeteer-core\// }, () => ({ path: 'connection', namespace: 'test' }));
            builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
                contents: 'export default { connect: options => options };', loader: 'js'
            }));
        } }]
    });
    const adapter = require(outfile).default;
    const options = { headless: true, userDataDir: path.join(directory, 'profile'), args: ['--remote-debugging-port=0'] };
    const first = adapter.defaultArgs(options);
    assert.ok(first.includes(`--user-data-dir=${options.userDataDir}`));
    assert.ok(first.includes('--remote-debugging-port=0'));
    first.push('--mutated');
    assert.ok(!adapter.defaultArgs(options).includes('--mutated'));
    for (const changed of [{ headless: false }, { userDataDir: 'relative' }, { userDataDir: '/bad\0profile' },
        { args: ['--no-sandbox'] }, { args: ['--disable-setuid-sandbox'] }, { args: ['--user-data-dir=/other'] },
        { args: ['https://example.org'] }]) {
        assert.throws(() => adapter.defaultArgs({ ...options, ...changed }), /sandboxed headless Chromium/);
    }
    const connection = { browserWSEndpoint: 'ws://127.0.0.1:1234/devtools/browser/owned-id', protocolTimeout: 15000 };
    assert.deepEqual(adapter.connect(connection), connection);
    for (const changed of [{ channel: 'chrome' }, { browserURL: 'http://localhost:1234' },
        { browserWSEndpoint: 'ws://example.org:1234/devtools/browser/remote' }]) {
        assert.throws(() => adapter.connect({ ...connection, ...changed }), /owned loopback/);
    }
    const manager = require(path.join(root, 'src/publication-browser-manager-disabled.mjs'));
    assert.throws(() => manager.detectBrowserPlatform(), /Browser management is unavailable/);
    assert.throws(() => manager.resolveDefaultUserDataDir(), /Browser management is unavailable/);
    assert.throws(() => manager.Browser.CHROME, /Browser management is unavailable/);
    assert.throws(() => manager.ChromeReleaseChannel.STABLE, /Browser management is unavailable/);
});

test('worker mode builds closed sibling runtimes without requiring the helper', async t => {
    const directory = temporary(t);
    const files = await runtime.buildPublication({ root, outdir: directory, mode: 'worker' });
    assert.deepEqual(files.map((file: string) => path.basename(file)).sort(), [
        'publication-mermaid-browser.js', 'publication-mermaid-browser.meta.json',
        'publication-mermaid-worker.meta.json', 'publication-mermaid-worker.mjs'
    ]);
    for (const name of ['publication-mermaid-browser', 'publication-mermaid-worker']) {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, name + '.meta.json'), 'utf8'));
        runtime.assertPublicationGraph(metadata, name.endsWith('browser') ? 'browser' : 'node');
        for (const output of Object.values(metadata.outputs) as { imports: { path: string }[] }[]) {
            assert.ok(output.imports.every(dependency => isBuiltin(dependency.path)));
        }
    }
    const worker = require(path.join(directory, 'publication-mermaid-worker.mjs'));
    assert.equal(typeof worker.connectOwnedBrowser, 'function');
    assert.equal(typeof worker.browserBatch, 'function');
    assert.equal(typeof worker.renderVector, 'function');
    const code = fs.readFileSync(path.join(directory, 'publication-mermaid-worker.mjs'), 'utf8');
    assert.ok(!code.includes('require.resolve("mermaid/package.json")'));
    assert.ok(code.includes('12.0.0'));
});

test('publication mode stubs self-hosting and does not replace outputs after a failed build', async t => {
    const directory = temporary(t);
    const sources = path.join(directory, 'src');
    fs.mkdirSync(sources);
    fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
    const dependencies = path.dirname(path.dirname(require.resolve('esbuild/package.json')));
    fs.symlinkSync(dependencies, path.join(directory, 'node_modules'), 'junction');
    for (const name of ['publication-puppeteer.mjs', 'publication-browser-manager-disabled.mjs']) {
        fs.copyFileSync(path.join(root, 'src', name), path.join(sources, name));
    }
    fs.writeFileSync(path.join(sources, 'publication-mermaid-browser.mjs'), 'globalThis.publicationMermaidReady = Promise.resolve();');
    fs.writeFileSync(path.join(sources, 'publication-mermaid-worker.mjs'), "export { default } from './publication-puppeteer.mjs';");
    const helper = path.join(sources, 'publication-helper.ts');
    fs.writeFileSync(helper, "export { verifySelfHosting } from './self-hosting';");
    const files: string[] = await runtime.buildPublication({ root: directory });
    assert.equal(files.length, 6);
    const code = require(path.join(directory, 'out/publication-helper.cjs'));
    assert.throws(() => code.verifySelfHosting(), /Self-hosting is unavailable/);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'out/publication-helper.meta.json'), 'utf8'));
    assert.ok(Object.keys(metadata.inputs).includes('publication:self-hosting-disabled'));
    const before = files.map(file => fs.readFileSync(file));
    fs.writeFileSync(helper, "import unavailable from 'unshipped-publication-package'; console.log(unavailable);");
    await assert.rejects(runtime.buildPublication({ root: directory }), /unshipped-publication-package/);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});

test('VSIX adds publication runtime and exploration preview, not build evidence', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    assert.deepEqual(ignore.split(/\r?\n/).filter(line => line.startsWith('!out/publication-')).sort(), [
        '!out/publication-exploration-preview.js', '!out/publication-helper.cjs', '!out/publication-mermaid-browser.js', '!out/publication-mermaid-worker.mjs'
    ]);
});
