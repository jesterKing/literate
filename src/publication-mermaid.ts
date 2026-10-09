import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import type { PublicationAsset } from './publication-pandoc';
import { getTheme } from './themes';
export interface DiagramBytes { pdf: Uint8Array; svg: Uint8Array }
export type DiagramRenderer = (assets: readonly PublicationAsset[], theme: string,
    executable?: string, checkCancelled?: () => void) => Promise<Map<string, DiagramBytes>>;
export const diagramLimits = { count: 128, source: 50000, pdf: 16 * 1024 * 1024,
    svg: 4 * 1024 * 1024, total: 32 * 1024 * 1024, timeMs: 120000 };
export type DiagramWorker = (directory: string, executable: string) => Promise<void>;
export function validateDiagram(source: string): void {
    if (!source.trim() || source.length > diagramLimits.source) {
        throw new Error('Mermaid source must contain 1–50000 characters');
    }
    if (/%%\s*\{/.test(source) || /^\s*---(?:\s|$)/.test(source)) {
        throw new Error('Mermaid directives and frontmatter are disabled');
    }
    if (/\b(?:style|classDef|linkStyle|click|links?)\s/i.test(commandText(source))
        || /<\s*\/?\s*[a-z][^>]*>/i.test(source)
        || /&(?:lt|#0*60|#x0*3c);/i.test(source)) {
        throw new Error('Mermaid authored HTML, CSS and interactions are disabled');
    }
}
function commandText(source: string): string {
    let result = '', quoted = false, comment = false;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '\n' || character === '\r') {
            quoted = false; comment = false; result += character;
        } else if (comment) { result += ' '; }
        else if (quoted && character === '\\') {
            result += ' ';
            if (index + 1 < source.length && !/[\r\n]/.test(source[index + 1])) { index++; result += ' '; }
        } else if (character === '"') { quoted = !quoted; result += ' '; }
        else if (!quoted && character === '%' && source[index + 1] === '%') {
            comment = true; result += ' ';
        } else { result += quoted ? ' ' : character; }
    }
    return result;
}
export function executeDiagramWorker(directory: string, executable: string,
    worker = path.join(__dirname, 'publication-mermaid-worker.mjs'),
    timeoutMs = diagramLimits.timeMs): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=256', worker, directory, executable],
            { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let failure = '', log = '', size = 0;
        const kill = (): void => {
            if (!child.pid) { return; }
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { failure ||= String(error); } }
        };
        const timer = setTimeout(() => { failure = 'Mermaid browser deadline exceeded'; kill(); }, timeoutMs);
        const interrupt = (): void => { failure = 'Mermaid rendering interrupted'; kill(); };
        const cleanup = (): void => {
            clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        };
        process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
        for (const stream of [child.stdout, child.stderr]) {
            stream.on('data', (data: Buffer) => {
                size += data.length;
                if (size > 65536) { failure = 'Mermaid worker log exceeds 64 KiB'; kill(); }
                else { log += data.toString('utf8'); }
            });
        }
        child.once('error', error => { cleanup(); kill(); reject(error); });
        child.once('close', (code, signal) => {
            cleanup(); kill();
            if (failure || code !== 0) {
                reject(new Error(`${failure || `Mermaid worker exited ${code ?? signal}`}: ${log.trim()}`));
            } else { resolve(); }
        });
    });
}
async function diagramArtifact(directory: string, index: number, format: 'pdf' | 'svg',
    checkCancelled?: () => void): Promise<Uint8Array> {
    const file = path.join(directory, `${index}.${format}`);
    const stat = await fs.lstat(file);
    checkCancelled?.();
    if (!stat.isFile() || stat.size < 1 || stat.size > diagramLimits[format]) {
        throw new Error(`Invalid or oversized Mermaid ${format} artifact`);
    }
    const bytes = await fs.readFile(file);
    checkCancelled?.();
    if (bytes.length > diagramLimits[format] || (format === 'pdf'
        ? bytes.subarray(0, 5).toString() !== '%PDF-' : !bytes.toString('utf8').startsWith('<svg'))) {
        throw new Error(`Invalid Mermaid ${format} artifact`);
    }
    return bytes;
}
export async function renderDiagrams(assets: readonly PublicationAsset[], theme: string,
    executable?: string, worker: DiagramWorker = executeDiagramWorker,
    checkCancelled?: () => void): Promise<Map<string, DiagramBytes>> {
    checkCancelled?.();
    const sources = [...new Set(assets.map(asset => asset.source))];
    if (!sources.length) { return new Map(); }
    for (const asset of assets) {
        try { validateDiagram(asset.source); }
        catch (error) { throw new Error(`${asset.at.path}:${asset.at.line + 1}: ${String(error)}`); }
    }
    if (sources.length > diagramLimits.count) {
        throw new Error(`Publication exceeds ${diagramLimits.count} unique Mermaid diagrams`);
    }
    if (!getTheme(theme)) { throw new Error('Unknown Mermaid publication theme'); }
    if (!executable || !path.isAbsolute(executable) || /[\u0000-\u001f]/.test(executable)) {
        throw new Error('Mermaid requires --browser /absolute/path/to/chromium; install a system browser explicitly. No browser is downloaded.');
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) { throw new Error('Mermaid export requires Node >=22.12'); }
    if (process.platform === 'win32') { throw new Error('Mermaid export requires POSIX process-group cleanup'); }
    try {
        const stat = await fs.stat(executable);
        checkCancelled?.();
        if (!stat.isFile()) { throw new Error('Not a regular file'); }
        await fs.access(executable, constants.X_OK);
    } catch (error) {
        checkCancelled?.();
        throw new Error(`Cannot execute --browser ${executable}: ${String(error)}`);
    }
    checkCancelled?.();
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'literate-mermaid-'));
    try {
        checkCancelled?.();
        await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ sources, theme }), { mode: 0o600 });
        checkCancelled?.();
        try { await worker(directory, executable); }
        catch (error) {
            const index = Number(/Diagram (\d+):/.exec(String(error))?.[1] ?? 1) - 1;
            const asset = assets.find(asset => asset.source === sources[index]) ?? assets[0];
            throw new Error(`${asset.at.path}:${asset.at.line + 1}: ${String(error)}`);
        }
        checkCancelled?.();
        const result = new Map<string, DiagramBytes>();
        let total = 0;
        for (const [index, source] of sources.entries()) {
            const pdf = await diagramArtifact(directory, index, 'pdf', checkCancelled);
            checkCancelled?.();
            const svg = await diagramArtifact(directory, index, 'svg', checkCancelled);
            checkCancelled?.();
            total += pdf.length + svg.length;
            if (total > diagramLimits.total) { throw new Error('Mermaid artifacts exceed 32 MiB'); }
            result.set(source, { pdf, svg });
        }
        return result;
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
