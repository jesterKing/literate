import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const esmRequire = 'import { createRequire as __publicationRequire } from "node:module"; '
    + 'const require = __publicationRequire(import.meta.url);';
export const publicationPins = Object.freeze({
    'puppeteer-core': '25.12.0',
    'mermaid': '12.0.0',
    '@mermaid-js/mermaid-zenuml': '1.0.1',
    '@mermaid-js/layout-tidy-tree': '1.0.1',
    'esbuild': '0.28.2'
});
async function dependencyMetadata(name) {
    let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
        try {
            const metadata = await json(path.join(directory, 'package.json'));
            if (metadata.name === name) { return metadata; }
        } catch (error) {
            if (error.code !== 'ENOENT') { throw error; }
        }
        const parent = path.dirname(directory);
        if (parent === directory) { throw new Error(`Cannot find metadata for ${name}`); }
        directory = parent;
    }
}
export async function validatePublicationVersions(root = projectRoot) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.versions.electron || major < 22 || (major === 22 && minor < 12)) {
        throw new Error('Publication builds require external Node >=22.12');
    }
    const manifest = await json(path.join(root, 'package.json'));
    for (const [name, version] of Object.entries(publicationPins)) {
        const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
        const installed = (await dependencyMetadata(name)).version;
        if (declared !== version || installed !== version) {
            throw new Error(`Publication requires ${name} ${version}; declared ${declared}, installed ${installed}`);
        }
    }
}
export async function publicationDefaultArgs() {
    for (const name of ['PUPPETEER_DANGEROUS_NO_SANDBOX', 'PUPPETEER_TEST_EXPERIMENTAL_CHROME_FEATURES']) {
        if (process.env[name] === 'true') { throw new Error(`Unset ${name} before building publication`); }
    }
    const { default: puppeteer } = await import('puppeteer-core');
    const args = await puppeteer.defaultArgs({ headless: true });
    if (!Array.isArray(args) || !args.includes('--headless=new')
        || args.some(arg => typeof arg !== 'string'
            || /^--(?:no-sandbox|disable-setuid-sandbox|user-data-dir|remote-debugging)/.test(arg))) {
        throw new Error('Unexpected pinned Puppeteer launch arguments');
    }
    return args;
}
function publicationOnly() {
    return { name: 'publication-only', setup(builder) {
        builder.onResolve({ filter: /^\.\/self-hosting(?:\.js)?$/ }, () => ({
            path: 'self-hosting-disabled', namespace: 'publication'
        }));
        builder.onLoad({ filter: /.*/, namespace: 'publication' }, () => ({
            contents: 'export function verifySelfHosting() {'
                + ' throw new Error("Self-hosting is unavailable in the publication helper"); }',
            loader: 'js'
        }));
    } };
}
export function assertPublicationGraph(metadata, platform) {
    const outputs = Object.values(metadata.outputs);
    if (outputs.length !== 1) { throw new Error('Publication bundles must contain exactly one output'); }
    for (const dependency of outputs[0].imports) {
        if (dependency.kind === 'require-resolve' || platform === 'browser' || !isBuiltin(dependency.path)) {
            throw new Error(`Unbundled publication dependency: ${dependency.path}`);
        }
    }
    for (const input of Object.keys(metadata.inputs)) {
        const name = input.replaceAll('\\', '/');
        if (/(?:^|\/)node_modules\/(?:typescript|esbuild|webpack|puppeteer|@puppeteer\/browsers)(?:\/|$)/.test(name)
            || /(?:^|\/)src\/(?:self-hosting\.ts|build-publication\.mjs)$/.test(name)
            || /puppeteer-core\/lib\/puppeteer\/(?:node\/PuppeteerNode|node\/ChromeLauncher|node\/BrowserLauncher|puppeteer-core)\.js$/.test(name)) {
            throw new Error(`Forbidden publication build input: ${input}`);
        }
    }
}
async function prepareBundle(root, outdir, name, options) {
    const outfile = path.join(outdir, name);
    const result = await build({
        absWorkingDir: root, bundle: true, minify: true, legalComments: 'eof',
        metafile: true, write: false, logLevel: 'error', outfile, ...options
    });
    assertPublicationGraph(result.metafile, options.platform);
    if (result.outputFiles.length !== 1) { throw new Error(`Unexpected sidecar for ${name}`); }
    return [
        { path: outfile, contents: result.outputFiles[0].contents },
        { path: outfile.replace(/\.(?:cjs|mjs|js)$/, '.meta.json'),
            contents: JSON.stringify(result.metafile, null, 2) + '\n' }
    ];
}
function prepareBrowser(root, outdir) {
    return prepareBundle(root, outdir, 'publication-mermaid-browser.js', {
        entryPoints: ['src/publication-mermaid-browser.mjs'],
        platform: 'browser', format: 'iife', target: 'chrome128'
    });
}
function prepareWorker(root, outdir, args) {
    return prepareBundle(root, outdir, 'publication-mermaid-worker.mjs', {
        entryPoints: ['src/publication-mermaid-worker.mjs'],
        platform: 'node', format: 'esm', target: 'node22.12',
        banner: { js: esmRequire },
        define: {
            PUBLICATION_CHROMIUM_DEFAULT_ARGS: JSON.stringify(args),
            'process.env.WS_NO_BUFFER_UTIL': '"1"',
            'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
        },
        alias: { '@puppeteer/browsers': path.join(root, 'src/publication-browser-manager-disabled.mjs') }
    });
}
function prepareHelper(root, outdir) {
    return prepareBundle(root, outdir, 'publication-helper.cjs', {
        entryPoints: ['src/publication-helper.ts'],
        platform: 'node', format: 'cjs', target: 'node22.12',
        plugins: [publicationOnly()]
    });
}
export async function buildPublication({ root = projectRoot, outdir, mode = 'publication' } = {}) {
    if (!['publication', 'worker', 'browser'].includes(mode)) {
        throw new Error(`Unknown publication build mode: ${mode}`);
    }
    root = path.resolve(root);
    outdir = path.resolve(outdir ?? path.join(root, 'out'));
    await validatePublicationVersions(root);
    const args = mode === 'browser' ? undefined : await publicationDefaultArgs();
    const files = await prepareBrowser(root, outdir);
    if (args) { files.push(...await prepareWorker(root, outdir, args)); }
    if (mode === 'publication') { files.push(...await prepareHelper(root, outdir)); }
    await fs.mkdir(outdir, { recursive: true });
    for (const file of files) { await fs.writeFile(file.path, file.contents); }
    return files.map(file => file.path);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    const mode = args.length === 0 ? 'publication'
        : args.length === 1 && args[0] === '--worker' ? 'worker'
        : args.length === 1 && args[0] === '--browser' ? 'browser' : undefined;
    if (!mode) {
        console.error('Usage: node src/build-publication.mjs [--worker|--browser]');
        process.exitCode = 1;
    } else {
        buildPublication({ mode }).catch(error => {
            console.error(`Publication build failed: ${error.message}`);
            process.exitCode = 1;
        });
    }
}
