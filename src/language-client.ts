import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { TextDecoder } from 'node:util';

export interface LanguageClientOptions {
    command: string;
    args?: string[];
    cwd: string;
    rootUri: string;
    initializationOptions?: unknown;
    configuration?: Record<string, unknown>;
    log?: (message: string) => void;
}
export interface LanguageDocument { uri: string; languageId: string; text: string; }
type ObjectValue = Record<string, unknown>;
type Pending = { finish: (error?: Error, value?: unknown) => void };
const limit = 8 * 1024 * 1024;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

export class LanguageClient {
    public capabilities: ObjectValue = {};
    private child?: ChildProcessWithoutNullStreams;
    private initialization?: Promise<void>;
    private disposal?: Promise<void>;
    private stopped?: Error;
    private closing = false;
    private initialized = false;
    private sequence = 0;
    private waiting = 0;
    private pending = new Map<number, Pending>();
    private documents = new Map<string, LanguageDocument & { version: number }>();
    private header = Buffer.alloc(0);
    private body?: Buffer;
    private received = 0;
    private exited?: Promise<void>;
    constructor(private readonly options: LanguageClientOptions) {}

    public initialize(): Promise<void> {
        if (this.closing || this.stopped) { return Promise.reject(this.stopped || new Error('Language client disposed')); }
        if (!this.initialization) { this.initialization = this.start(); }
        return this.initialization;
    }

    private async start(): Promise<void> {
        try {
            this.launch();
            const result = await this.rpc('initialize', {
                processId: process.pid, rootUri: this.options.rootUri,
                workspaceFolders: this.folders(), initializationOptions: this.options.initializationOptions,
                capabilities: {
                    general: { positionEncodings: ['utf-16'] },
                    workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
                    textDocument: { synchronization: { dynamicRegistration: false },
                        completion: { completionItem: { snippetSupport: false, insertReplaceSupport: true } },
                        hover: { contentFormat: ['plaintext', 'markdown'] } }
                }
            }, undefined, 15000);
            if (!object(result) || !object(result.capabilities)) { throw new Error('Invalid initialize result'); }
            this.capabilities = result.capabilities;
            if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== 'utf-16') {
                throw new Error('Language server must use UTF-16 positions');
            }
            this.send({ method: 'initialized', params: {} });
            this.initialized = true;
        } catch (error) { this.fail(failure(error)); throw error; }
    }

    private launch(): void {
        const child = this.child = spawn(this.options.command, this.options.args || [], {
            cwd: this.options.cwd, shell: false, stdio: 'pipe'
        });
        this.exited = new Promise(resolve => {
            child.once('exit', (code, signal) => {
                this.fail(new Error(`Language server exited (${code ?? signal})`)); resolve();
            });
            child.once('error', error => { this.fail(error); resolve(); });
        });
        child.stdout.on('data', (chunk: Buffer) => {
            try { this.consume(chunk); } catch (error) { this.fail(failure(error)); }
        });
        child.stdout.on('end', () => this.fail(new Error('Language server stdout closed')));
        child.stdout.on('error', error => this.fail(error));
        child.stdin.on('error', error => this.fail(error));
        child.stderr.on('error', error => this.fail(error));
        child.stderr.on('data', (chunk: Buffer) => {
            try { this.options.log?.(chunk.subarray(0, 8192).toString('utf8')); } catch { /* Logging must not break transport. */ }
        });
    }

    private consume(chunk: Buffer): void {
        while (chunk.length && !this.stopped) {
            if (!this.body) {
                const byte = chunk.subarray(0, 1);
                chunk = chunk.subarray(1);
                this.header = Buffer.concat([this.header, byte]);
                if (this.header.length > 8192) { throw new Error('LSP header limit exceeded'); }
                if (this.header.length < 4 || this.header.subarray(-4).toString() !== '\r\n\r\n') { continue; }
                const headers = this.header.toString('ascii').slice(0, -4).split('\r\n');
                const lengths = headers.filter(line => /^content-length:/i.test(line));
                if (lengths.length !== 1 || !/^content-length: *[0-9]+ *$/i.test(lengths[0])) {
                    throw new Error('Invalid LSP Content-Length');
                }
                const size = Number(lengths[0].split(':')[1]);
                if (!Number.isSafeInteger(size) || size < 1 || size > limit) { throw new Error('LSP message limit exceeded'); }
                this.body = Buffer.allocUnsafe(size); this.received = 0; this.header = Buffer.alloc(0);
            }
            const count = Math.min(chunk.length, this.body.length - this.received);
            chunk.copy(this.body, this.received, 0, count);
            this.received += count; chunk = chunk.subarray(count);
            if (this.received === this.body.length) {
                const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body));
                this.body = undefined; this.received = 0; this.dispatch(message);
            }
        }
    }

    private dispatch(message: unknown): void {
        if (!object(message) || message.jsonrpc !== '2.0') { throw new Error('Invalid JSON-RPC message'); }
        if (typeof message.method === 'string') {
            if (message.id !== undefined) {
                if (typeof message.id !== 'number' && typeof message.id !== 'string') { throw new Error('Invalid request id'); }
                this.answer(message.method, message.params, message.id);
            }
            return;
        }
        if (typeof message.id !== 'number' || (('result' in message) === ('error' in message))) {
            throw new Error('Invalid JSON-RPC response');
        }
        const pending = this.pending.get(message.id);
        if ('error' in message) {
            if (!object(message.error) || typeof message.error.message !== 'string' || typeof message.error.code !== 'number') {
                throw new Error('Invalid JSON-RPC error');
            }
            pending?.finish(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        } else { pending?.finish(undefined, message.result); }
    }

    private folders(): { uri: string; name: string }[] {
        return [{ uri: this.options.rootUri, name: basename(this.options.cwd) || this.options.cwd }];
    }

    private section(section: unknown): unknown {
        const config = this.options.configuration || {};
        if (section === undefined || section === '') { return config; }
        if (typeof section !== 'string') { return null; }
        if (Object.prototype.hasOwnProperty.call(config, section)) { return config[section] ?? null; }
        let value: unknown = config;
        for (const key of section.split('.')) {
            if (!object(value) || !Object.prototype.hasOwnProperty.call(value, key)) { return null; }
            value = value[key];
        }
        return value ?? null;
    }

    private answer(method: string, params: unknown, id: string | number): void {
        let result: unknown;
        if (method === 'workspace/configuration' && object(params) && Array.isArray(params.items)) {
            result = params.items.map(item => object(item) ? this.section(item.section) : null);
        } else if (method === 'workspace/workspaceFolders') { result = this.folders(); }
        else if (method === 'workspace/applyEdit') { result = { applied: false, failureReason: 'Read-only language client' }; }
        else {
            this.send({ id, error: { code: -32601, message: `Unsupported method: ${method}` } }); return;
        }
        this.send({ id, result });
    }

    private send(message: ObjectValue): void {
        if (this.stopped || !this.child) { throw this.stopped || new Error('Language server not started'); }
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
        if (body.length > limit) { throw new Error('LSP outgoing message limit exceeded'); }
        const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
        if (this.child.stdin.writableLength + header.length + body.length > limit + 8192) {
            const error = new Error('LSP output queue limit exceeded'); this.fail(error); throw error;
        }
        this.child.stdin.write(Buffer.concat([header, body]));
    }

    public async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) { throw this.cancelled(); }
        await this.waitForInitialization(signal);
        if (this.closing) { throw new Error('Language client disposed'); }
        return this.rpc(method, params, signal);
    }

    private cancelled(): Error { return Object.assign(new Error('Language request cancelled'), { name: 'AbortError' }); }

    private waitForInitialization(signal?: AbortSignal): Promise<void> {
        if (this.waiting >= 128) { return Promise.reject(new Error('LSP initialization wait limit exceeded')); }
        this.waiting++;
        const ready = this.initialize().finally(() => { this.waiting--; });
        if (!signal) { return ready; }
        return new Promise((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(this.cancelled()); };
            signal.addEventListener('abort', abort, { once: true });
            ready.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => {
                signal.removeEventListener('abort', abort); reject(error);
            });
            if (signal.aborted) { abort(); }
        });
    }

    private rpc(method: string, params: unknown, signal?: AbortSignal, timeout = 5000): Promise<unknown> {
        if (this.stopped) { return Promise.reject(this.stopped); }
        if (signal?.aborted) { return Promise.reject(this.cancelled()); }
        if (this.pending.size >= 128) { return Promise.reject(new Error('LSP pending request limit exceeded')); }
        return new Promise((resolve, reject) => {
            const id = ++this.sequence;
            const finish = (error?: Error, value?: unknown) => {
                if (!this.pending.delete(id)) { return; }
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                if (error) { reject(error); } else { resolve(value); }
            };
            const cancel = (error: Error) => {
                finish(error);
                try { this.send({ method: '$/cancelRequest', params: { id } }); } catch (error) { this.fail(failure(error)); }
            };
            const abort = () => cancel(this.cancelled());
            const timer = setTimeout(() => cancel(new Error(`LSP request timed out: ${method}`)), timeout);
            this.pending.set(id, { finish });
            signal?.addEventListener('abort', abort, { once: true });
            try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
            catch (error) { finish(failure(error)); }
        });
    }

    public async sync(documents: LanguageDocument[]): Promise<void> {
        await this.initialize();
        if (this.closing || this.stopped) { throw this.stopped || new Error('Language client disposed'); }
        const sync = this.capabilities.textDocumentSync;
        const kind = typeof sync === 'number' ? sync : object(sync) ? sync.change : 0;
        if (documents.length && kind !== 1 && kind !== 2) { throw new Error('Language server document synchronization unsupported'); }
        const openClose = typeof sync === 'number' || (object(sync) && sync.openClose === true);
        if (documents.length && !openClose) { throw new Error('Language server open/close synchronization required for projections'); }
        const next = new Map(documents.map(doc => [doc.uri, { ...doc }]));
        let bytes = 0;
        for (const doc of next.values()) { bytes += Buffer.byteLength(JSON.stringify(doc), 'utf8'); }
        if (documents.length > 1024 || next.size !== documents.length || bytes > limit / 2) {
            throw new Error('LSP document set limit exceeded or duplicate URI');
        }
        for (const [uri, old] of this.documents) {
            if (!next.has(uri) || next.get(uri)!.languageId !== old.languageId) {
                if (openClose) { this.send({ method: 'textDocument/didClose', params: { textDocument: { uri } } }); }
                this.documents.delete(uri);
            }
        }
        for (const doc of next.values()) { this.updateDocument(doc, kind, openClose); }
    }

    private updateDocument(doc: LanguageDocument, kind: unknown, openClose: boolean): void {
        const old = this.documents.get(doc.uri);
        if (old?.text === doc.text) { return; }
        const version = (old?.version || 0) + 1;
        if (!old && openClose) {
            this.send({ method: 'textDocument/didOpen', params: { textDocument: { ...doc, version } } });
        } else {
            const lines = (old?.text || '').split(/\r\n|\r|\n/);
            const range = { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } };
            this.send({ method: 'textDocument/didChange', params: {
                textDocument: { uri: doc.uri, version }, contentChanges: [{ ...(kind === 2 ? { range } : {}), text: doc.text }]
            } });
        }
        this.documents.set(doc.uri, { ...doc, version });
    }

    private fail(error: Error): void {
        if (this.stopped) { return; }
        this.stopped = error;
        for (const pending of this.pending.values()) { pending.finish(error); }
        this.documents.clear(); this.header = Buffer.alloc(0); this.body = undefined;
        this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy();
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGKILL'); }
    }

    public dispose(): Promise<void> {
        if (!this.disposal) { this.closing = true; this.disposal = this.stop(); }
        return this.disposal;
    }

    private async stop(): Promise<void> {
        if (this.initialized && !this.stopped) {
            for (const pending of this.pending.values()) { pending.finish(new Error('Language client disposed')); }
            try {
                await this.rpc('shutdown', undefined, undefined, 500);
                this.send({ method: 'exit' });
                await new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, 500);
                    this.exited?.then(() => { clearTimeout(timer); resolve(); });
                });
            } catch { /* A stalled shutdown is bounded by forced termination. */ }
        }
        this.fail(new Error('Language client disposed'));
    }
}
