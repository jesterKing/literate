import * as vscode from 'vscode';
import * as path from 'node:path';
import type { LanguageClient, LanguageDocument } from './language-client';
import { LanguageLocationContext, mapLanguageDiagnosticRange } from './language-navigation';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
type Problem = { uri: vscode.Uri; diagnostic: vscode.Diagnostic; id: string };
interface RawReport { version: number; items: RecordValue[]; bytes: number; }
interface ClientCache { reports: Map<string, RawReport>; unsubscribe: () => void; }
interface Session {
    client: LanguageClient;
    context: LanguageLocationContext;
    documents: LanguageDocument[];
    fresh: () => boolean;
    versions: Map<string, number | undefined>;
    staged: Map<string, RecordValue>;
    reports: Map<string, Problem[]>;
    unsubscribe: (() => void)[];
    abort: AbortController;
    syncing: boolean;
    pulling: boolean;
}

export class LanguageDiagnostics {
    private readonly collection = vscode.languages.createDiagnosticCollection('literate-language');
    private readonly sessions = new Map<string, Session>();
    private readonly syncs = new WeakMap<LanguageClient, Promise<void>>();
    private readonly caches = new Map<LanguageClient, ClientCache>();
    private disposed = false;
    constructor(context: vscode.ExtensionContext, private readonly report: (message: string) => void) {
        context.subscriptions.push(this);
    }

    public async synchronize(key: string, client: LanguageClient, context: LanguageLocationContext,
        documents: LanguageDocument[], fresh: () => boolean): Promise<void> {
        if (this.disposed) { return; }
        const previous = this.sessions.get(key);
        const identity = (location: LanguageLocationContext, docs: LanguageDocument[]) =>
            JSON.stringify([location.root.toString(), location.files, location.documents, docs]);
        if (previous?.client === client && !previous.syncing && !previous.abort.signal.aborted && fresh()
            && [...previous.versions].every(([uri, version]) => version === client.documentVersion(uri))
            && identity(previous.context, previous.documents) === identity(context, documents)) {
            previous.fresh = fresh;
            return;
        }
        this.invalidate(key);
        const snapshot = documents.map(document => ({ ...document }));
        context = { root: context.root, documents: context.documents.map(document => ({ ...document })),
            files: context.files.map(file => ({ ...file, mappings: file.mappings.map(mapping => ({ ...mapping })) })) };
        const owned = new Map(context.files.map(file =>
            [vscode.Uri.file(path.resolve(context.root.fsPath, file.path)).toString(), file.content]));
        const session: Session = { client, context, documents: snapshot, fresh, versions: new Map(snapshot
            .filter(document => owned.get(document.uri) === document.text).map(document => [document.uri, undefined])),
            staged: new Map(), reports: new Map(), unsubscribe: [], abort: new AbortController(), syncing: true, pulling: false };
        this.sessions.set(key, session);
        session.unsubscribe.push(client.onNotification('textDocument/publishDiagnostics', value => this.push(key, session, value)));
        session.unsubscribe.push(client.onNotification('workspace/diagnostic/refresh', () => this.schedule(key, session)));
        const stop = client.onDidStop(() => { if (this.sessions.get(key) === session) { this.invalidate(key); } });
        if (session.abort.signal.aborted) { stop(); } else { session.unsubscribe.push(stop); }
        const pending = (this.syncs.get(client) || Promise.resolve()).catch(() => {}).then(async () => {
            if (this.current(key, session)) { await client.sync(snapshot); }
        });
        this.syncs.set(client, pending);
        try { await pending; }
        catch (error) { if (this.sessions.get(key) === session) { this.invalidate(key); } throw error; }
        if (!this.current(key, session)) { return; }
        for (const uri of session.versions.keys()) { session.versions.set(uri, client.documentVersion(uri)); }
        session.syncing = false;
        const cache = this.caches.get(client);
        for (const [uri, report] of cache?.reports || []) {
            if (report.version !== client.documentVersion(uri)) { cache!.reports.delete(uri); }
            else if (session.versions.get(uri) === report.version) { this.accept(session, uri, report.items, false); }
        }
        const staged = [...session.staged.values()]; session.staged.clear();
        for (const value of staged) { this.push(key, session, value); }
        this.schedule(key, session);
    }

    private current(key: string, session: Session): boolean {
        return !this.disposed && this.sessions.get(key) === session && !session.abort.signal.aborted && session.fresh();
    }
    private pullProvider(session: Session): RecordValue | undefined {
        const provider = session.client.capabilities.diagnosticProvider;
        return record(provider) ? provider : undefined;
    }
    private push(key: string, session: Session, value: unknown): void {
        if (!this.current(key, session) || this.pullProvider(session) || !record(value)
            || typeof value.uri !== 'string' || !session.versions.has(value.uri) || !Array.isArray(value.diagnostics)) { return; }
        if (value.version !== undefined && (!Number.isSafeInteger(value.version) || (value.version as number) < 0)) { return; }
        if (session.syncing) {
            if (value.version !== undefined && session.staged.size < 64) {
                session.staged.set(value.uri, { ...value, diagnostics: value.diagnostics.slice(0, 1000) });
            }
            return;
        }
        const version = session.versions.get(value.uri);
        if (version === undefined || version !== session.client.documentVersion(value.uri)
            || (value.version !== undefined && value.version !== version)) { return; }
        this.accept(session, value.uri, value.diagnostics);
    }

    private schedule(key: string, session: Session): void {
        if (!this.current(key, session) || session.syncing || session.pulling || !this.pullProvider(session)) { return; }
        session.pulling = true;
        // One bounded cycle coalesces refresh storms, including refreshes sent by a failing request.
        void Promise.resolve().then(async () => {
            for (const [uri, version] of [...session.versions].slice(0, 64)) {
                if (!this.current(key, session)) { break; }
                if (version === undefined || session.client.documentVersion(uri) !== version) { continue; }
                try {
                    const provider = this.pullProvider(session)!;
                    const identifier = typeof provider.identifier === 'string' ? provider.identifier : undefined;
                    const reply = await session.client.request('textDocument/diagnostic', {
                        textDocument: { uri }, ...(identifier === undefined ? {} : { identifier })
                    }, session.abort.signal);
                    if (!this.current(key, session)) { break; }
                    if (session.client.documentVersion(uri) === version && record(reply)
                        && reply.kind === 'full' && Array.isArray(reply.items)) { this.accept(session, uri, reply.items); }
                } catch {
                    if (this.current(key, session)) { this.log('Language diagnostics request failed; waiting for the next sync or refresh.'); }
                    break;
                }
            }
        }).finally(() => { session.pulling = false; });
    }

    private accept(session: Session, uri: string, items: unknown[], remember = true): void {
        if (remember) { this.remember(session, uri, items); }
        session.reports.delete(uri);
        const seen = new Set<string>(), problems: Problem[] = [];
        const counts = new Map<string, number>();
        let total = 0, unmapped = 0;
        for (const report of session.reports.values()) {
            for (const problem of report) {
                total++;
                const source = problem.uri.toString(); counts.set(source, (counts.get(source) || 0) + 1);
            }
        }
        for (const item of items.slice(0, 1000)) {
            if (!record(item) || typeof item.message !== 'string' || !item.message.trim()) { continue; }
            const locations = mapLanguageDiagnosticRange(uri, item.range, session.context);
            if (!locations.length) { unmapped++; }
            for (const location of locations) {
                const severity = typeof item.severity === 'number' && Number.isInteger(item.severity)
                    && item.severity >= 1 && item.severity <= 4 ? item.severity - 1 : vscode.DiagnosticSeverity.Error;
                const diagnostic = new vscode.Diagnostic(location.range, item.message.slice(0, 8192), severity);
                if (typeof item.code === 'string') { diagnostic.code = item.code.slice(0, 256); }
                else if (typeof item.code === 'number' && Number.isFinite(item.code)) { diagnostic.code = item.code; }
                if (typeof item.source === 'string') { diagnostic.source = item.source.slice(0, 256); }
                if (Array.isArray(item.tags)) {
                    diagnostic.tags = [1, 2].filter(tag => (item.tags as unknown[]).includes(tag));
                }
                const source = location.uri.toString(), { start, end } = location.range;
                const id = JSON.stringify([source, start.line, start.character, end.line, end.character,
                    diagnostic.message, severity, diagnostic.code, diagnostic.source, diagnostic.tags]);
                if (seen.has(id) || total >= 5000 || (counts.get(source) || 0) >= 1000) { continue; }
                seen.add(id); total++; counts.set(source, (counts.get(source) || 0) + 1);
                problems.push({ uri: location.uri, diagnostic, id });
            }
        }
        session.reports.set(uri, problems);
        if (unmapped) { this.log(`Language diagnostics: ${unmapped} unmapped or invalid generated ranges omitted.`); }
        this.publish();
    }

    private remember(session: Session, uri: string, items: unknown[]): void {
        const version = session.versions.get(uri);
        const document = session.documents.find(document => document.uri === uri);
        if (version === undefined || !document) { return; }
        const lines = document.text.split(/\r\n|\r|\n/);
        const point = (value: unknown): value is { line: number; character: number } =>
            record(value) && Number.isSafeInteger(value.line) && Number.isSafeInteger(value.character)
            && (value.line as number) >= 0 && (value.character as number) >= 0
            && typeof lines[value.line as number] === 'string'
            && (value.character as number) <= lines[value.line as number].length;
        const safe: RecordValue[] = [];
        for (const item of items.slice(0, 1000)) {
            if (!record(item) || typeof item.message !== 'string' || !item.message.trim() || !record(item.range)) { continue; }
            const { start, end } = item.range;
            if (!point(start) || !point(end) || start.line > end.line
                || (start.line === end.line && start.character > end.character)) { continue; }
            safe.push({ range: { start: { line: start.line, character: start.character },
                end: { line: end.line, character: end.character } }, message: item.message.slice(0, 8192),
                severity: typeof item.severity === 'number' && Number.isInteger(item.severity)
                    && item.severity >= 1 && item.severity <= 4 ? item.severity : 1,
                code: typeof item.code === 'string' ? item.code.slice(0, 256)
                    : typeof item.code === 'number' && Number.isFinite(item.code) ? item.code : undefined,
                source: typeof item.source === 'string' ? item.source.slice(0, 256) : undefined,
                tags: Array.isArray(item.tags) ? [1, 2].filter(tag => (item.tags as unknown[]).includes(tag)) : undefined });
        }
        let cache = this.caches.get(session.client);
        if (!cache) {
            cache = { reports: new Map(), unsubscribe: () => {} };
            this.caches.set(session.client, cache);
            const client = session.client;
            const unsubscribe = client.onDidStop(() => this.forget(client));
            if (!this.caches.has(session.client)) { unsubscribe(); return; }
            cache.unsubscribe = unsubscribe;
        }
        cache.reports.delete(uri);
        const bytes = Buffer.byteLength(JSON.stringify(safe), 'utf8');
        if (bytes <= 4 * 1024 * 1024) { cache.reports.set(uri, { version, items: safe, bytes }); }
        let count = 0, size = 0;
        for (const report of cache.reports.values()) { count += report.items.length; size += report.bytes; }
        while (cache.reports.size > 64 || count > 5000 || size > 4 * 1024 * 1024) {
            const oldest = cache.reports.keys().next().value!;
            const report = cache.reports.get(oldest)!;
            count -= report.items.length; size -= report.bytes; cache.reports.delete(oldest);
        }
        while (this.caches.size > 16) { this.forget(this.caches.keys().next().value!); }
    }
    private forget(client: LanguageClient): void {
        const cache = this.caches.get(client);
        this.caches.delete(client);
        cache?.unsubscribe(); cache?.reports.clear();
    }

    private publish(): void {
        if (this.disposed) { return; }
        const files = new Map<string, [vscode.Uri, vscode.Diagnostic[]]>(), seen = new Set<string>();
        for (const [key, session] of this.sessions) {
            if (!this.current(key, session) || session.syncing) { continue; }
            for (const problems of session.reports.values()) {
                for (const problem of problems) {
                    const source = problem.uri.toString();
                    let entry = files.get(source);
                    if (!entry) { entry = [problem.uri, []]; files.set(source, entry); }
                    if (!seen.has(problem.id) && entry[1].length < 1000) {
                        seen.add(problem.id); entry[1].push(problem.diagnostic);
                    }
                }
            }
        }
        this.collection.clear();
        this.collection.set([...files.values()]);
    }
    private log(message: string): void {
        try { this.report(message); } catch { /* Reporting cannot interrupt lifecycle cleanup. */ }
    }
    public invalidate(key?: string): void {
        for (const [name, session] of this.sessions) {
            if (key !== undefined && key !== name) { continue; }
            this.sessions.delete(name);
            session.abort.abort();
            for (const unsubscribe of session.unsubscribe) { unsubscribe(); }
            session.staged.clear(); session.reports.clear();
        }
        this.publish();
    }
    public dispose(): void {
        if (this.disposed) { return; }
        this.invalidate();
        for (const client of this.caches.keys()) { this.forget(client); }
        this.disposed = true; this.collection.dispose();
    }
}
