// Opt-in acceptance of existing bundles; no build, generation, install or download.
// node src/test/acceptance/publication-package.mjs --node /usr/bin/node \
//   --browser /usr/bin/chromium-browser --font-manifest /absolute/fonts.json \
//   --ulem /absolute/existing/ulem.sty
// Optional --vsix /absolute/existing.vsix tests its extracted runtime instead.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeFiles = ['publication-helper.cjs', 'publication-mermaid-worker.mjs', 'publication-mermaid-browser.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    assert.ok(['--node', '--browser', '--font-manifest', '--ulem', '--vsix'].includes(key)
        && value && path.isAbsolute(value) && !options.has(key), 'Expected unique named absolute paths; see script header');
    options.set(key, value);
}
for (const key of ['--node', '--browser', '--font-manifest']) { assert.ok(options.has(key), `Required: ${key}`); }
for (const value of options.values()) { assert.ok((await fs.stat(value)).isFile(), `Not a file: ${value}`); }
assert.equal(process.platform, 'linux', 'This isolation proof requires Linux bubblewrap');
const evidence = await fs.mkdtemp(path.join(repo, 'out/publication-package-'));
console.log(`Evidence: ${evidence}`);
const report = { inputs: Object.fromEntries(options), packageSource: options.get('--vsix') ?? 'existing out bundles',
    passed: {}, failures: [], limitations: [
        'This is a packaged-helper test, not an extension-host command/UI test.',
        'Cancellation is covered by the main tests; this harness does not infer phases from timing.',
        'Dependency closure checks are not a complete transitive license audit.'
    ] };
const saveReport = () => fs.writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
const record = async (name, value) => { report.passed[name] = value; await saveReport(); console.log(`PASS ${name}`); };
function command(executable, args, settings = {}) {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 250000,
        maxBuffer: 16 * 1024 * 1024, ...settings });
    if (result.error) { throw result.error; }
    assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
}
async function tree(directory, prefix = '') {
    const result = {};
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name, target = path.join(directory, entry.name);
        if (entry.isDirectory()) { Object.assign(result, await tree(target, name + '/')); }
        else { assert.ok(entry.isFile(), `Unexpected non-file: ${target}`); result[name] = hash(await fs.readFile(target)); }
    }
    return result;
}
async function copyFonts(project) {
    const source = options.get('--font-manifest');
    const manifest = JSON.parse(await fs.readFile(source, 'utf8'));
    await fs.mkdir(path.join(project, 'inputs'));
    const copy = async name => {
        assert.equal(typeof name, 'string');
        const input = path.resolve(path.dirname(source), name);
        const destination = 'inputs/' + hash(Buffer.from(name)) + path.extname(input);
        await fs.copyFile(input, path.join(project, destination));
        return destination;
    };
    for (const family of Object.values(manifest.families)) {
        for (const face of ['regular', 'bold', 'italic', 'boldItalic']) {
            if (typeof family[face] === 'string') { family[face] = await copy(family[face]); }
            else { family[face].file = await copy(family[face].file); }
        }
        family.licenses = await Promise.all(family.licenses.map(copy));
    }
    await fs.writeFile(path.join(project, 'fonts.json'), JSON.stringify(manifest, null, 2) + '\n');
}
async function preparePackage(installed) {
    const vsix = options.get('--vsix');
    if (vsix) {
        const entries = command('unzip', ['-Z1', vsix]).trim().split(/\r?\n/);
        assert.ok(!entries.some(name => /(?:^|\/)node_modules\//.test(name)), 'VSIX contains node_modules');
        assert.deepEqual(entries.filter(name => /^extension\/out\/publication-/.test(name)).sort(),
            runtimeFiles.map(name => 'extension/out/' + name).sort());
        assert.ok(entries.includes('extension/THIRD_PARTY_NOTICES.md'));
        await fs.writeFile(path.join(evidence, 'vsix-entries.txt'), entries.join('\n') + '\n');
        for (const name of runtimeFiles) {
            const bytes = command('unzip', ['-p', vsix, 'extension/out/' + name], { encoding: null });
            assert.deepEqual(bytes, await fs.readFile(path.join(repo, 'out', name)), `VSIX/out mismatch: ${name}`);
            await fs.writeFile(path.join(installed, name), bytes);
        }
        await record('actual-vsix', { file: vsix, sha256: hash(await fs.readFile(vsix)), runtimeMatchesOut: true });
    } else {
        for (const name of runtimeFiles) { await fs.copyFile(path.join(repo, 'out', name), path.join(installed, name)); }
        report.limitations.push('No actual VSIX supplied: archive contents are not proven by the allowlist check.');
    }
    const ignore = (await fs.readFile(path.join(repo, '.vscodeignore'), 'utf8')).split(/\r?\n/);
    assert.deepEqual(ignore.filter(line => line.startsWith('!out/publication-')).sort(), runtimeFiles.map(name => '!out/' + name).sort());
    const bundles = {};
    for (const name of runtimeFiles) {
        const metadataName = name.replace(/\.(?:cjs|mjs|js)$/, '.meta.json');
        const metadata = JSON.parse(await fs.readFile(path.join(repo, 'out', metadataName), 'utf8'));
        const outputs = Object.entries(metadata.outputs);
        assert.equal(outputs.length, 1, `Unexpected chunks: ${name}`);
        assert.equal(path.basename(outputs[0][0]), name);
        const bytes = await fs.readFile(path.join(installed, name));
        assert.equal(outputs[0][1].bytes, bytes.length, `Stale metafile: ${name}`);
        for (const dependency of outputs[0][1].imports) {
            assert.notEqual(dependency.kind, 'require-resolve');
            assert.ok(name !== 'publication-mermaid-browser.js' && isBuiltin(dependency.path), `Unbundled: ${dependency.path}`);
        }
        for (const input of Object.keys(metadata.inputs)) {
            const normalized = input.replaceAll('\\', '/');
            assert.ok(!/(?:^|\/)node_modules\/(?:typescript|esbuild|webpack|puppeteer|@puppeteer\/browsers)(?:\/|$)/.test(normalized), input);
            assert.ok(!/(?:^|\/)src\/(?:self-hosting\.ts|build-publication\.mjs)$/.test(normalized), input);
            assert.ok(!/puppeteer-core\/lib\/puppeteer\/(?:puppeteer-core|node\/PuppeteerNode|node\/ChromeLauncher|node\/BrowserLauncher)\.js$/.test(normalized), input);
        }
        await fs.copyFile(path.join(repo, 'out', metadataName), path.join(evidence, metadataName));
        bundles[name] = { bytes: bytes.length, sha256: hash(bytes), inputs: Object.keys(metadata.inputs).length,
            imports: outputs[0][1].imports };
    }
    await record('bundle-closure-and-allowlist', bundles);
}

// The supervisor is passed as an argument, not a fourth installed file. Its PID
// namespace also tears down descendants if the outer bounded invocation fails.
const supervisor = `
const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process');
const [node, helper, hidden] = process.argv.slice(1);
assert.equal(fs.existsSync(hidden), false);
assert.equal(process.versions.electron, undefined);
for (const name of ['mermaid', 'puppeteer-core', 'markdown-it', 'typescript', 'esbuild']) {
    assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
}
const request = fs.readFileSync(0);
const result = cp.spawnSync(node, [helper], { input: request, encoding: 'utf8', timeout: 230000, maxBuffer: 8388608 });
if (result.error) throw result.error;
console.log(JSON.stringify({ code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    scratch: fs.readdirSync('/tmp/work'), runtime: process.versions.node, executable: process.execPath,
    files: fs.readdirSync('/tmp/package').sort() }));
`;
function sandboxArguments(installed, project, texinputs) {
    const args = ['--ro-bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev',
        '--unshare-pid', '--die-with-parent', '--tmpfs', '/tmp',
        '--ro-bind', installed, '/tmp/package', '--bind', project, '/tmp/book'];
    if (texinputs) { args.push('--ro-bind', texinputs, '/tmp/texinputs'); }
    args.push('--tmpfs', '/home', '--dir', '/tmp/home', '--dir', '/tmp/work', '--chdir', '/tmp/package',
        '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp/home',
        '--setenv', 'TMPDIR', '/tmp/work', '--setenv', 'LANG', 'C.UTF-8');
    if (texinputs) { args.push('--setenv', 'TEXINPUTS', '/tmp/texinputs:'); }
    args.push('--', options.get('--node'), '-e', supervisor, options.get('--node'),
        '/tmp/package/publication-helper.cjs', path.join(repo, 'node_modules'));
    return args;
}

try {
    const installed = path.join(evidence, 'installed'), project = path.join(evidence, 'project');
    await fs.mkdir(installed); await fs.mkdir(project);
    await preparePackage(installed);
    await copyFonts(project);
    let texinputs;
    if (options.has('--ulem')) {
        texinputs = path.join(evidence, 'texinputs'); await fs.mkdir(texinputs);
        await fs.copyFile(options.get('--ulem'), path.join(texinputs, 'ulem.sty'));
    }
    const disk = '# DiskOnlySentinel\n\nThis disk content must not be published.\n';
    await fs.writeFile(path.join(project, 'index.literate'), disk);
    const documents = [{ path: 'index.literate', text: '# Snapshot publication\n\n'
        + '```SETTINGS\ntheme=rosepine-dawn\n```\n\n'
        + 'UnsavedSnapshotSentinel: this text exists only in the request.\n\n'
        + 'Native **bold**, *italic*, and `CodeSentinel` use explicit portable fonts.\n\n'
        + '```js : <<program.*>>= generated.js $\nconst SourceSentinel = 42;\n```\n\n'
        + '```mermaid\nflowchart TD\nA[Unsaved] --> B[Published]\n```\n' },
        { path: 'unsaved-only.literate', text: '# Unsaved chapter\n\nUnsavedOnlyChapterSentinel.\n' }];
    await fs.writeFile(path.join(evidence, 'snapshot.json'), JSON.stringify(documents, null, 2));
    const initial = await tree(project);
    const bwrap = sandboxArguments(installed, project, texinputs);
    await fs.writeFile(path.join(evidence, 'bubblewrap-arguments.json'), JSON.stringify(bwrap, null, 2));
    async function invoke(label, args, success = true) {
        const request = JSON.stringify({ args, documents });
        await fs.writeFile(path.join(evidence, label + '-request.json'), request + '\n');
        const result = spawnSync('bwrap', bwrap, { input: request, encoding: 'utf8', timeout: 250000, maxBuffer: 16 * 1024 * 1024 });
        await fs.writeFile(path.join(evidence, label + '-sandbox.stdout'), result.stdout ?? '');
        await fs.writeFile(path.join(evidence, label + '-sandbox.stderr'), result.stderr ?? '');
        if (result.error) { throw result.error; }
        assert.equal(result.status, 0, result.stderr);
        const envelope = JSON.parse(result.stdout);
        await fs.writeFile(path.join(evidence, label + '.json'), envelope.stdout);
        await fs.writeFile(path.join(evidence, label + '.stderr'), envelope.stderr);
        assert.equal(envelope.code, success ? 0 : 1, envelope.stdout + envelope.stderr);
        assert.equal(envelope.signal, null);
        assert.deepEqual(envelope.files, [...runtimeFiles].sort());
        assert.deepEqual(envelope.scratch, [], 'Publication left a build or browser scratch directory');
        const response = JSON.parse(envelope.stdout);
        assert.equal(response.ok, success, envelope.stdout);
        assert.deepEqual(response.diagnostics, []);
        return { response, runtime: envelope.runtime, executable: envelope.executable, stderr: envelope.stderr };
    }
    const flags = ['--font-manifest', 'fonts.json', '--browser', options.get('--browser'), '--json'];
    const latex = await invoke('latex', ['latex', '/tmp/book', '--output', 'export/book.tex', ...flags]);
    assert.ok(latex.response.outputs.every(output => output.status === 'written'));
    const tex = await fs.readFile(path.join(project, 'export/book.tex'), 'utf8');
    assert.match(tex, /UnsavedSnapshotSentinel/); assert.match(tex, /UnsavedOnlyChapterSentinel/);
    assert.doesNotMatch(tex, /DiskOnlySentinel/);
    const afterLatex = await tree(project);
    for (const [name, digest] of Object.entries(initial)) { assert.equal(afterLatex[name], digest, name); }
    assert.ok(!Object.hasOwn(afterLatex, 'generated.js'));
    assert.ok(!Object.hasOwn(afterLatex, 'unsaved-only.literate'));
    const diagrams = Object.keys(afterLatex).filter(name => /lit-assets-.*\.pdf$/.test(name));
    assert.equal(diagrams.length, 1);
    const diagramInfo = command('pdfinfo', [path.join(project, diagrams[0])]);
    const diagramImages = command('pdfimages', ['-list', path.join(project, diagrams[0])]);
    assert.match(diagramInfo, /Pages:\s+1\b/);
    assert.doesNotMatch(diagramImages, /^\s*\d+\s+\d+\s+(?:image|mask|smask)\b/m);
    await fs.writeFile(path.join(evidence, 'diagram-info.txt'), diagramInfo + '\n' + diagramImages);
    await record('snapshot-latex', { ...latex, sourceUnchanged: true, unsavedOnlyDocument: true, vectorDiagram: true });
    const repeat = await invoke('latex-repeat', ['latex', '/tmp/book', '--output', 'export/book.tex', ...flags]);
    assert.ok(repeat.response.outputs.every(output => output.status === 'current'));
    assert.deepEqual(await tree(project), afterLatex);
    await record('unchanged-latex-repeat', repeat);
    const pdf = await invoke('pdf', ['pdf', '/tmp/book', '--output', 'book.pdf', ...flags]);
    assert.deepEqual(pdf.response.outputs, [{ path: 'book.pdf', status: 'written' }]);
    const afterPdf = await tree(project);
    const pdfDigest = afterPdf['book.pdf']; delete afterPdf['book.pdf'];
    assert.deepEqual(afterPdf, afterLatex, 'PDF publication changed something other than book.pdf');
    const filename = path.join(project, 'book.pdf');
    assert.equal((await fs.readFile(filename)).subarray(0, 5).toString(), '%PDF-');
    const text = command('pdftotext', [filename, '-']);
    assert.match(text, /UnsavedSnapshotSentinel/); assert.match(text, /UnsavedOnlyChapterSentinel/);
    assert.doesNotMatch(text, /DiskOnlySentinel/);
    const info = command('pdfinfo', [filename]), fonts = command('pdffonts', [filename]);
    await fs.writeFile(path.join(evidence, 'book.txt'), text);
    await fs.writeFile(path.join(evidence, 'book-info.txt'), info);
    await fs.writeFile(path.join(evidence, 'book-fonts.txt'), fonts);
    assert.match(fonts, /Lilex/i);
    await record('snapshot-pdf', { ...pdf, sha256: pdfDigest, onlyPdfPublished: true,
        pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]), portableFonts: true });
    const beforeRejected = await tree(project);
    const rejected = await invoke('reject-generation', ['generate', '/tmp/book', '--json'], false);
    assert.deepEqual(rejected.response.outputs, []);
    assert.ok(rejected.response.errors.length);
    assert.deepEqual(await tree(project), beforeRejected);
    await record('publication-only-request-boundary', rejected);
    report.ok = true;
} catch (error) {
    report.ok = false; report.failures.push(error.stack ?? String(error)); process.exitCode = 1;
    console.error(error);
} finally { await saveReport(); }
