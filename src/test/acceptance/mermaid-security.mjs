// Explicit real-browser security probes; never part of the normal headless suite.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { renderDiagrams, executeDiagramWorker } = require(path.join(repo, 'out/publication-mermaid.js'));
const executable = process.argv[2];
assert.ok(executable && path.isAbsolute(executable), 'Supply an explicit absolute system-browser path');
const root = await fs.mkdtemp(path.join(repo, 'out/mermaid-security-'));
let hits = 0;
const server = createServer((request, response) => { hits++; response.end('unexpected network access'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/probe`;
const workerModule = pathToFileURL(path.join(repo, 'out/publication-mermaid-worker.mjs')).href;
const coreModule = pathToFileURL(require.resolve('puppeteer-core')).href;
const script = path.join(root, 'probe.mjs');
await fs.writeFile(script, `
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import puppeteer from ${JSON.stringify(coreModule)};
import {connectOwnedBrowser, isolatePage} from ${JSON.stringify(workerModule)};
const directory=process.argv[2];
const browser=await connectOwnedBrowser(puppeteer,{executablePath:process.argv[3],headless:true,
 userDataDir:path.join(directory,'profile'),args:['--disable-background-networking','--disable-component-update',
 '--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND','--js-flags=--max-old-space-size=256']});
try {
 const page=await browser.newPage();
 const violations=await isolatePage(page);
 await fs.writeFile(path.join(directory,'secret'),'PRIVATE_FILE_SENTINEL');
 const result=await page.evaluate(async (url,file)=>{
   const attempts=await Promise.allSettled([fetch(url),fetch(file)]);
   const image=document.createElement('img');image.src=url;document.body.append(image);
   await new Promise(resolve=>setTimeout(resolve,100));
   return {statuses:attempts.map(item=>item.status),csp:globalThis.publicationViolations};
 },${JSON.stringify(url)},'file://'+directory+'/secret');
 assert.deepEqual(result.statuses,['rejected','rejected']);
 assert.ok(result.csp.length>=2);
 // default-src does not restrict top-level navigation: interception must block it independently.
 await assert.rejects(page.goto(${JSON.stringify(url)}));
 assert.ok(violations.length>0);
 await fs.writeFile(path.join(directory,'0.pdf'),'%PDF-1.4\\n');
 await fs.writeFile(path.join(directory,'0.svg'),'<svg><desc>'+JSON.stringify({csp:result.csp,interception:violations})+'</desc></svg>');
} finally {await browser.close();}
`);
const source = 'flowchart TD\nA-->B';
const asset = { kind: 'mermaid', source, caption: '', at: { path: 'probe.literate', line: 0, column: 0 } };
const report = { hits: 0, errors: [] };
try {
    const result = await renderDiagrams([asset], 'rosepine-dawn', executable,
        (directory, browser) => executeDiagramWorker(directory, browser, script, 30000));
    report.policy = Buffer.from(result.get(source).svg).toString();
    assert.equal(hits, 0);
    for (const input of ['flowchart TD\nA[', 'flowchart TD\nA@{ img: "' + url + '", label: "unsafe" }',
        'flowchart TD\n' + Array.from({ length: 501 }, (_, i) => `A${i}-->A${i + 1}`).join('\n'),
        'flowchart LR\n' + Array.from({ length: 250 }, (_, i) => `A${i}[Wide node]-->A${i + 1}[Wide node]`).join('\n')]) {
        await assert.rejects(renderDiagrams([{ ...asset, source: input }], 'rosepine-dawn', executable), error => {
            report.errors.push(String(error)); return /Diagram 1:/.test(String(error));
        }, input.slice(0, 100));
    }
    assert.equal(hits, 0); report.hits = hits;
    await fs.writeFile(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Passed real-browser network/file isolation, syntax, image, edge and geometry limits: ${root}`);
} finally { await new Promise(resolve => server.close(resolve)); }
