import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import mermaidPackage from 'mermaid/package.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getTheme, mermaidTheme } from './themes';
import { diagramLimits, validateDiagram } from './publication-mermaid';

const hash = value => createHash('sha256').update(value).digest('hex');
export function configuration(theme, seed) {
    return { ...mermaidTheme(getTheme(theme)), startOnLoad: false,
        securityLevel: 'strict', look: 'classic', suppressErrorRendering: true, maxTextSize: 50000,
        maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false },
        fontFamily: 'sans-serif', deterministicIds: true, deterministicIDSeed: seed,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering',
            'maxTextSize', 'maxEdges', 'theme', 'themeVariables', 'fontFamily',
            'htmlLabels', 'flowchart', 'look', 'deterministicIds', 'deterministicIDSeed'] };
}

export async function isolatePage(page) {
    const violations = [];
    const origin = 'https://literate.invalid/';
    let bootstrap = true;
    page.setDefaultTimeout(15000);
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (bootstrap && request.url() === origin && request.isNavigationRequest()
            && request.frame() === page.mainFrame()) {
            bootstrap = false;
            void request.respond({ status: 200, contentType: 'text/html', headers: {
                'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                    + "connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; "
                    + "base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin"
            }, body: '<!doctype html><style>html,body{margin:0;padding:0}svg{display:block}'
                        + '*,*::before,*::after{font-family:sans-serif!important}</style><body></body>'
            }).catch(error => violations.push(String(error)));
        } else {
            violations.push('resource request');
            void request.abort('blockedbyclient').catch(() => {});
        }
    });
    page.on('framenavigated', frame => {
        if (frame.url() !== origin) { violations.push('navigation'); }
    });
    page.on('popup', popup => { violations.push('popup'); void popup.close().catch(() => {}); });
    await page.setBypassServiceWorker(true);
    await page.goto(origin, { waitUntil: 'load' });
    await page.evaluate(() => {
        globalThis.publicationViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            globalThis.publicationViolations.push(event.violatedDirective + ': ' + event.blockedURI.slice(0, 200));
        });
    });
    return violations;
}
export function measureSvg() {
    const svg = document.querySelector('body > svg');
    if (!svg) { throw new Error('Mermaid returned no root SVG'); }
    if (svg.querySelector('script,image,img,a,iframe,object,embed,video,audio,animate,animateMotion,animateTransform,set,form,input,button')) {
        throw new Error('Mermaid SVG contains unsupported active or external content');
    }
    const checkCss = value => {
        if (/@import/i.test(value)) { throw new Error('External SVG CSS is disabled'); }
        for (const match of value.matchAll(/url\(([^)]*)\)/gi)) {
            if (!match[1].trim().replace(/^["']|["']$/g, '').startsWith('#')) {
                throw new Error('External SVG CSS resource is disabled');
            }
        }
    };
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
        if (element.namespaceURI === 'http://www.w3.org/1999/xhtml'
            && !['div', 'span', 'p', 'br', 'b', 'strong', 'i', 'em', 'small', 'code', 'pre',
                'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li'].includes(element.localName)) {
            throw new Error('Unsupported active HTML in Mermaid label');
        }
        for (const attribute of element.attributes) {
            if (/^on/i.test(attribute.name) || (/href$/i.test(attribute.name) && !attribute.value.startsWith('#'))) {
                throw new Error('Mermaid SVG interaction or external reference is disabled');
            }
            checkCss(attribute.value);
        }
        if (element.localName === 'style') { checkCss(element.textContent); }
    }
    const fixed = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    fixed.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;filter:none!important;font-family:sans-serif!important}';
    svg.prepend(fixed);
    const box = svg.getBBox(), view = svg.viewBox.baseVal;
    const x = Math.min(box.x, view.x) - 8, y = Math.min(box.y, view.y) - 8;
    const width = Math.ceil(Math.max(box.x + box.width, view.x + view.width) - x + 8);
    const height = Math.ceil(Math.max(box.y + box.height, view.y + view.height) - y + 8);
    if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1
        || width > 16384 || height > 16384 || width * height > 16000000) {
        throw new Error('Mermaid geometry exceeds 16384 px per side or 16 million pixels');
    }
    svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    svg.style.maxWidth = 'none';
    return { width, height, svg: svg.outerHTML };
}
export async function renderVector(browser, source, theme, bundle) {
    const context = await browser.createBrowserContext();
    try {
        const page = await context.newPage();
        await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
        const violations = await isolatePage(page);
        await page.addScriptTag({ content: bundle });
        const seed = hash(JSON.stringify([source, theme]));
        await page.evaluate(async (source, config, id) => {
            const policy = document.createElement('meta');
            policy.httpEquiv = 'Content-Security-Policy'; policy.content = "script-src 'none'";
            document.head.append(policy);
            await globalThis.publicationMermaidReady;
            globalThis.mermaid.initialize(config);
            await globalThis.mermaid.parse(source);
            const result = await globalThis.mermaid.render(id, source);
            if (!result.svg.trim()) { throw new Error('Mermaid returned empty SVG: ' + JSON.stringify(result)); }
        
            document.body.style.backgroundColor = config.themeVariables.background;
            document.body.innerHTML = result.svg;
            const svg = document.body.querySelector('svg');
            if (svg) { svg.style.backgroundColor = config.themeVariables.background; }
            await document.fonts.ready;
        }, source, configuration(theme, seed), 'diagram-' + seed);
        const geometry = await page.evaluate(measureSvg);
        if (Buffer.byteLength(geometry.svg) > diagramLimits.svg) { throw new Error('Mermaid SVG exceeds 4 MiB'); }
        const bytes = await page.pdf({ width: `${geometry.width + 1}px`, height: `${geometry.height + 1}px`,
            margin: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true,
            preferCSSPageSize: false, timeout: 15000 });
        const blocked = await page.evaluate(() => globalThis.publicationViolations);
        if (violations.length || blocked.length) { throw new Error('Mermaid attempted a blocked resource or navigation: ' + [...violations, ...blocked].join(', ')); }
        if (bytes.length > diagramLimits.pdf) { throw new Error('Mermaid PDF exceeds 16 MiB'); }
        const pdf = Buffer.from(Buffer.from(bytes).toString('latin1').replace(
            /\/(CreationDate|ModDate) \(D:\d{14}[^)]*\)/g,
            match => match.replace(/D:\d{14}/, 'D:20000101000000')), 'latin1');
        return { pdf, svg: Buffer.from(geometry.svg) };
    } finally { await context.close(); }
}
export async function browserBatch(directory, executable, launch) {
    const request = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8'));
    if (!getTheme(request.theme) || !Array.isArray(request.sources)
        || request.sources.length > diagramLimits.count) {
        throw new Error('Invalid Mermaid worker request');
    }
    request.sources.forEach(validateDiagram);
    if (mermaidPackage.version !== '12.0.0') {
        throw new Error('Publication requires the pinned Mermaid 12.0.0 bundle');
    }
    const bundle = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
            'publication-mermaid-browser.js'), 'utf8');
    const browser = await launch({ executablePath: executable, headless: true,
        userDataDir: path.join(directory, 'profile'), timeout: 15000, protocolTimeout: 15000,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
            '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND',
            '--js-flags=--max-old-space-size=256', '--renderer-process-limit=1'] });
    try {
        let total = 0;
        for (const [index, source] of request.sources.entries()) {
            try {
                const result = await renderVector(browser, source, request.theme, bundle);
                total += result.pdf.length + result.svg.length;
                if (total > diagramLimits.total) { throw new Error('Mermaid artifacts exceed 32 MiB'); }
                await fs.writeFile(path.join(directory, `${index}.pdf`), result.pdf);
                await fs.writeFile(path.join(directory, `${index}.svg`), result.svg);
            } catch (error) { throw new Error(`Diagram ${index + 1}: ${String(error)}`); }
        }
    } finally { await browser.close(); }
}
export async function connectOwnedBrowser(puppeteer, options) {
    const args = await puppeteer.defaultArgs({ ...options, args: [...options.args,
        '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    if (!Array.isArray(args) || !args.includes(`--user-data-dir=${options.userDataDir}`)) {
        throw new Error('Puppeteer did not provide the isolated browser arguments');
    }
    const home = path.dirname(options.userDataDir);
    const child = spawn(options.executablePath, args, { detached: false,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
            XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
            CHROMIUM_USER_FLAGS: ' ' }, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
        const endpoint = await browserEndpoint(child);
        return await puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: 15000 });
    } catch (error) { child.kill('SIGKILL'); throw error; }
}
function browserEndpoint(child) {
    return new Promise((resolve, reject) => {
        let log = '', done = false;
        const finish = (error, endpoint) => {
            if (done) { return; }
            done = true; clearTimeout(timer);
            if (error) { reject(error); } else { resolve(endpoint); }
        };
        const timer = setTimeout(() => finish(new Error(`Chromium launch deadline exceeded: ${log}`)), 15000);
        child.once('error', error => finish(error));
        child.once('exit', code => finish(new Error(`Chromium exited ${code}: ${log}`)));
        child.stderr.on('data', bytes => {
            if (done) { return; }
            log += bytes.toString('utf8');
            if (log.length > 32768) { finish(new Error('Chromium launch log exceeds 32 KiB')); return; }
            const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(log);
            if (match) { finish(undefined, match[1]); }
        });
    });
}
async function main() {
    try {
        const { default: puppeteer } = await import('./publication-puppeteer.mjs');
        await browserBatch(process.argv[2], process.argv[3], options => connectOwnedBrowser(puppeteer, options));
    } catch (error) {
        process.stderr.write(('Mermaid browser failed (use external Node >=22.12 and a sandbox-capable system Chromium): '
            + String(error)).slice(0, 16000) + '\n', () => process.exit(1));
    }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { void main(); }
