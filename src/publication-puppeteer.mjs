import * as path from 'node:path';
import puppeteer from 'puppeteer-core/internal/puppeteer-core-browser.js';
export function defaultArgs(options) {
    if (options.headless !== true || !path.isAbsolute(options.userDataDir ?? '')
        || /[\u0000-\u001f]/.test(options.userDataDir) || !Array.isArray(options.args)
        || options.args.some(arg => typeof arg !== 'string' || !arg.startsWith('--')
            || /^--(?:no-sandbox|disable-setuid-sandbox|user-data-dir)(?:=|$)/.test(arg))) {
        throw new Error('Publication requires sandboxed headless Chromium and a private absolute profile');
    }
    return [...PUBLICATION_CHROMIUM_DEFAULT_ARGS,
        `--user-data-dir=${options.userDataDir}`, ...options.args];
}
export function connect(options) {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+$/.test(options.browserWSEndpoint ?? '')
        || Object.keys(options).some(key => !['browserWSEndpoint', 'protocolTimeout'].includes(key))) {
        throw new Error('Publication connects only to its owned loopback Chromium endpoint');
    }
    return puppeteer.connect(options);
}
export default { defaultArgs, connect };
