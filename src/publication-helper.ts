import type { SourceDocument } from './engine';
import type { Readable } from 'node:stream';

export const maximumRequestBytes = 32 * 1024 * 1024;
export interface PublicationRequest { args: string[]; documents: SourceDocument[]; }

export function validateRuntime(versions: { node: string; electron?: string } = process.versions): void {
    const [major, minor] = versions.node.split('.').map(Number);
    if (versions.electron !== undefined || !Number.isInteger(major) || !Number.isInteger(minor)
        || major < 22 || (major === 22 && minor < 12)) {
        throw new Error('Publication helper requires external Node >=22.12 (not Electron)');
    }
}

export function parseRequest(text: string): PublicationRequest {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected a publication request object');
    }
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some(key => key !== 'args' && key !== 'documents')
        || !Array.isArray(request.args) || !request.args.every(arg => typeof arg === 'string')
        || !['latex', 'pdf'].includes(request.args[0]) || !request.args.includes('--json')
        || request.args.some(arg => ['--help', '-h'].includes(arg))
        || !Array.isArray(request.documents)) {
        throw new Error('Expected {args, documents}: latex or pdf first, --json required, no help');
    }
    return request as unknown as PublicationRequest;
}
export function readRequest(input: Readable, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const cleanup = (): void => {
            clearTimeout(timer);
            input.removeListener('data', data);
            input.removeListener('end', end);
            input.removeListener('error', failed);
            signal.removeEventListener('abort', aborted);
            input.pause();
        };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        const aborted = (): void => failed(new Error('Publication request cancelled'));
        const data = (chunk: Buffer | string): void => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maximumRequestBytes) { failed(new Error('Publication request exceeds 32 MiB')); }
            else { chunks.push(buffer); }
        };
        const end = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
        const timer = setTimeout(() => failed(new Error('Publication request timed out after 30000 ms')), 30000);
        signal.addEventListener('abort', aborted, { once: true });
        input.on('data', data).once('end', end).once('error', failed);
        if (signal.aborted) { aborted(); }
    });
}
export async function publicationHelper(): Promise<number> {
    const controller = new AbortController();
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const cancel = (): void => { controller.abort(); };
    for (const signal of signals) { process.on(signal, cancel); }
    let output = '';
    try {
        validateRuntime();
        const request = parseRequest(await readRequest(process.stdin, controller.signal));
        const { run } = await import('./cli');
        if (controller.signal.aborted) { throw new Error('Publication request cancelled'); }
        const code = await run(request.args, {
            stdout: text => { output += text; },
            stderr: () => { throw new Error('Unexpected non-JSON publication output'); }
        }, undefined, undefined, undefined, undefined, { documents: request.documents });
        process.stdout.write(output);
        return code;
    } catch (error) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'publication', ok: false,
            diagnostics: [], outputs: [], errors: [error instanceof Error ? error.message : String(error)] }) + '\n');
        return 1;
    } finally {
        for (const signal of signals) { process.removeListener(signal, cancel); }
        process.stdin.pause();
    }
}
if (require.main === module) {
    void publicationHelper().then(code => { process.exitCode = code; });
}
