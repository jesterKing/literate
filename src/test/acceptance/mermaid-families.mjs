// Real offline coverage of lazy renderer families and the separately registered ZenUML plugin.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { renderDiagrams } = require(path.join(repo, 'out/publication-mermaid.js'));
const browser = process.argv[2];
assert.ok(browser && path.isAbsolute(browser), 'Supply an explicit absolute system-browser path');
const root = await fs.mkdtemp(path.join(repo, 'out/mermaid-families-'));
const fixtures = JSON.parse(await fs.readFile(new URL('./mermaid-families.json', import.meta.url), 'utf8'));
const metadata = JSON.parse(await fs.readFile(path.join(repo, 'out/publication-mermaid-browser.meta.json'), 'utf8'));
assert.equal(Object.keys(metadata.outputs).length, 1, 'Exactly one self-contained browser bundle');
assert.equal(Object.values(metadata.outputs)[0].imports.length, 0, 'No unresolved or network-loaded modules');
const inputs = Object.keys(metadata.inputs);
assert.ok(inputs.some(name => name.includes('mermaid-zenuml.esm/zenuml-definition')));
assert.ok(inputs.some(name => name.includes('mermaid.esm/mindmap-definition')));
assert.ok(inputs.some(name => name.includes('mermaid.esm/architectureDiagram')));
const report = { browser, bundleInputs: inputs, passed: [], failed: {} };
for (const [family, source] of Object.entries(fixtures)) {
    try {
        const result = await renderDiagrams([{ kind: 'mermaid', source, caption: '',
            at: { path: family + '.literate', line: 0, column: 0 } }], 'rosepine-dawn', browser);
        const bytes = result.get(source);
        await fs.writeFile(path.join(root, family + '.pdf'), bytes.pdf);
        await fs.writeFile(path.join(root, family + '.svg'), bytes.svg);
        const info = spawnSync('pdfinfo', [path.join(root, family + '.pdf')], { encoding: 'utf8', timeout: 10000 });
        assert.equal(info.status, 0, info.stderr); assert.match(info.stdout, /Pages:\s+1\b/);
        const images = spawnSync('pdfimages', ['-list', path.join(root, family + '.pdf')], { encoding: 'utf8', timeout: 10000 });
        assert.equal(images.status, 0, images.stderr);
        assert.doesNotMatch(images.stdout, /^\s*\d+\s+\d+\s+(?:image|mask|smask)\b/m);
        await fs.writeFile(path.join(root, family + '.info'), info.stdout + '\n' + images.stdout);
        report.passed.push(family); console.log('PASS', family);
    } catch (error) {
        report.failed[family] = String(error); console.error('FAIL', family, String(error));
    }
    await fs.writeFile(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`Evidence: ${root}`);
if (Object.keys(report.failed).length) { process.exitCode = 1; }
