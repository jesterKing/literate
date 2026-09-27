import * as vscode from 'vscode';
import * as path from 'node:path';
import { SourceDocument } from './engine';
import { LanguageClient } from './language-client';
import { mapGeneratedRange, mapSourcePosition, projectLanguageSources, SourceProjectionPosition } from './language-projection';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const aliases: Record<string, string> = { ts: 'typescript', js: 'javascript', tsx: 'typescriptreact', jsx: 'javascriptreact',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    py: 'python', rb: 'ruby', sh: 'shellscript', bash: 'shellscript', yml: 'yaml', cs: 'csharp', 'c++': 'cpp', rs: 'rust' };
const language = (value: string): string => Object.prototype.hasOwnProperty.call(aliases, value.toLowerCase())
    ? aliases[value.toLowerCase()] : value.toLowerCase();
const family = (value: string): boolean => ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(value);
interface Server { command: string; args: string[]; initializationOptions?: ObjectValue; configuration?: ObjectValue; }
interface RequestView { document: vscode.TextDocument; position: vscode.Position; hit: SourceProjectionPosition; }
function servers(invalid: () => void = () => undefined): Record<string, Server> {
    const raw = vscode.workspace.getConfiguration('literate').inspect<unknown>('languageServers')?.globalValue;
    const result: Record<string, Server> = Object.create(null);
    if (!object(raw)) { if (raw !== undefined) { invalid(); } return result; }
    for (const [id, entry] of Object.entries(raw)) {
        if (!/^[a-z][a-z0-9+-]*$/.test(id) || language(id) !== id || !object(entry)
            || typeof entry.command !== 'string' || !path.isAbsolute(entry.command) || entry.command.includes('\0')
            || (entry.args !== undefined && (!Array.isArray(entry.args)
                || !entry.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))))
            || (entry.initializationOptions !== undefined && !object(entry.initializationOptions))
            || (entry.configuration !== undefined && !object(entry.configuration))) { invalid(); continue; }
        result[id] = { command: entry.command, args: entry.args === undefined ? [] : [...entry.args as string[]],
            initializationOptions: entry.initializationOptions as ObjectValue | undefined,
            configuration: entry.configuration as ObjectValue | undefined };
    }
    return result;
}
function local(folder: vscode.WorkspaceFolder, document: vscode.TextDocument): boolean {
    return vscode.workspace.isTrusted && !vscode.env.remoteName && folder.uri.scheme === 'file' && !folder.uri.authority
        && document.uri.scheme === 'file' && !document.uri.authority && !document.isClosed
        && document.languageId === 'markdown' && document.uri.fsPath.endsWith('.literate')
        && !!vscode.workspace.workspaceFolders?.includes(folder)
        && vscode.workspace.getWorkspaceFolder(document.uri) === folder;
}
function offset(text: string, value: unknown): number | undefined {
    if (!object(value) || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character)
        || (value.line as number) < 0 || (value.character as number) < 0) { return undefined; }
    const lines = text.split(/\r\n|\r|\n/);
    const line = value.line as number, character = value.character as number;
    if (line >= lines.length || character > lines[line].length) { return undefined; }
    let start = 0, index = 0;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        if (index++ === line) { break; }
        start = match.index! + match[0].length;
    }
    return start + character;
}
function position(text: string, at: number): { line: number; character: number } {
    const lines = text.slice(0, at).split(/\r\n|\r|\n/);
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
function mappedRange(view: RequestView, value: unknown): vscode.Range | undefined {
    if (!object(value)) { return undefined; }
    const { file, mapping } = view.hit;
    const start = offset(file.content, value.start), end = offset(file.content, value.end);
    if (start === undefined || end === undefined) { return undefined; }
    const mapped = mapGeneratedRange(file, start, end, mapping);
    if (!mapped) { return undefined; }
    const range = new vscode.Range(view.document.positionAt(mapped.start), view.document.positionAt(mapped.end));
    return range.start.line === range.end.line && range.start.line === view.position.line && range.contains(view.position)
        ? range : undefined;
}
function wordRange(view: RequestView): vscode.Range {
    const { document, position: cursor, hit } = view;
    const word = document.getWordRangeAtPosition(cursor, /[\p{L}\p{N}_$]+/u);
    if (word && word.start.line === cursor.line && word.end.line === cursor.line && word.contains(cursor)
        && document.offsetAt(word.start) >= hit.mapping.sourceStart
        && document.offsetAt(word.end) <= hit.mapping.sourceEnd) { return word; }
    return new vscode.Range(cursor, cursor);
}
function completions(view: RequestView, reply: unknown): vscode.CompletionItem[] | undefined {
    if (object(reply) && ('itemDefaults' in reply || 'editDefaults' in reply)) { return undefined; }
    const items = Array.isArray(reply) ? reply : object(reply) && Array.isArray(reply.items) ? reply.items : undefined;
    return items?.slice(0, 1000).flatMap(value => {
        const item = completion(view, value);
        return item ? [item] : [];
    });
}
function completion(view: RequestView, value: unknown): vscode.CompletionItem | undefined {
    if (!object(value) || typeof value.label !== 'string' || !value.label.length || value.label.length > 4096
        || 'command' in value || 'editDefaults' in value || 'textEditText' in value || value.kind === 15
        || (value.insertTextFormat !== undefined && value.insertTextFormat !== 1)
        || (value.insertTextMode !== undefined && value.insertTextMode !== 1)
        || (value.additionalTextEdits !== undefined && (!Array.isArray(value.additionalTextEdits) || value.additionalTextEdits.length))
        || (value.insertText !== undefined && typeof value.insertText !== 'string')) { return undefined; }
    const item = new vscode.CompletionItem(value.label);
    let text = typeof value.insertText === 'string' ? value.insertText : value.label;
    item.range = wordRange(view);
    if (value.textEdit !== undefined) {
        const edit = value.textEdit;
        if (!object(edit) || typeof edit.newText !== 'string') { return undefined; }
        text = edit.newText;
        if ('range' in edit) {
            if ('insert' in edit || 'replace' in edit) { return undefined; }
            const range = mappedRange(view, edit.range);
            if (!range) { return undefined; }
            item.range = range;
        } else {
            const inserting = mappedRange(view, edit.insert), replacing = mappedRange(view, edit.replace);
            if (!inserting || !replacing || !inserting.start.isEqual(replacing.start)
                || !replacing.contains(inserting)) { return undefined; }
            item.range = { inserting, replacing };
        }
    }
    if (text.length > 65536) { return undefined; }
    item.insertText = text;
    for (const key of ['sortText', 'filterText', 'detail'] as const) {
        const text = value[key];
        if (typeof text === 'string') { item[key] = text.slice(0, 4096); }
    }
    const kinds = [vscode.CompletionItemKind.Text, vscode.CompletionItemKind.Method, vscode.CompletionItemKind.Function,
        vscode.CompletionItemKind.Constructor, vscode.CompletionItemKind.Field, vscode.CompletionItemKind.Variable,
        vscode.CompletionItemKind.Class, vscode.CompletionItemKind.Interface, vscode.CompletionItemKind.Module,
        vscode.CompletionItemKind.Property, vscode.CompletionItemKind.Unit, vscode.CompletionItemKind.Value,
        vscode.CompletionItemKind.Enum, vscode.CompletionItemKind.Keyword, vscode.CompletionItemKind.Snippet,
        vscode.CompletionItemKind.Color, vscode.CompletionItemKind.File, vscode.CompletionItemKind.Reference,
        vscode.CompletionItemKind.Folder, vscode.CompletionItemKind.EnumMember, vscode.CompletionItemKind.Constant,
        vscode.CompletionItemKind.Struct, vscode.CompletionItemKind.Event, vscode.CompletionItemKind.Operator,
        vscode.CompletionItemKind.TypeParameter];
    if (Number.isInteger(value.kind) && (value.kind as number) >= 1 && (value.kind as number) <= kinds.length) {
        item.kind = kinds[(value.kind as number) - 1];
    }
    return item;
}
function hoverText(value: unknown): vscode.MarkdownString | undefined {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    if (typeof value === 'string') { markdown.appendMarkdown(value.slice(0, 8192)); }
    else if (object(value) && typeof value.value === 'string') {
        const text = value.value.slice(0, 8192);
        if (value.kind === 'plaintext') { markdown.appendText(text); }
        else if (value.kind === 'markdown') { markdown.appendMarkdown(text); }
        else if (typeof value.language === 'string' && /^[\w+-]{1,40}$/.test(value.language)) {
            markdown.appendCodeblock(text, value.language);
        } else { return undefined; }
    } else { return undefined; }
    return markdown.value ? markdown : undefined;
}
function hover(view: RequestView, reply: unknown): vscode.Hover | undefined {
    if (!object(reply)) { return undefined; }
    const values = Array.isArray(reply.contents) ? reply.contents.slice(0, 8) : [reply.contents];
    const contents = values.map(hoverText).filter((value): value is vscode.MarkdownString => !!value);
    if (!contents.length) { return undefined; }
    const range = reply.range === undefined ? wordRange(view) : mappedRange(view, reply.range);
    if (!range) { return undefined; }
    return new vscode.Hover(contents, range);
}
export function registerLanguageFeatures(context: vscode.ExtensionContext,
    snapshot: (folder: vscode.WorkspaceFolder) => Promise<SourceDocument[]>): void {
    type Session = { client: LanguageClient; failed: boolean };
    const sessions = new Map<string, Session>();
    let epoch = 0, busy = false, disposed = false;
    let active: AbortController | undefined;
    const invalidate = (): void => { epoch++; active?.abort(); };
    const close = (client: LanguageClient): void => { void client.dispose().catch(() => undefined); };
    let invalidReported = false;
    const reset = (): void => {
        invalidate(); sessions.forEach(session => { if (!session.failed) { close(session.client); } });
        sessions.clear(); invalidReported = false;
    };
    context.subscriptions.push({ dispose() { disposed = true; reset(); } });
    const output = vscode.window.createOutputChannel('Literate Language Servers');
    let lines = 0;
    const report = (message: string): void => {
        if (disposed) { return; }
        if (lines >= 100) { output.clear(); lines = 0; }
        output.appendLine(message); lines++;
    };
    const invalid = (): void => {
        if (invalidReported) { return; }
        invalidReported = true;
        report('Invalid global literate.languageServers: use canonical language IDs, an absolute executable command, '
            + 'optional string-array args and object initializationOptions/configuration. Workspace overrides are ignored.');
    };
    context.subscriptions.push(output, vscode.commands.registerCommand('literate.restartLanguageServers', () => {
        if (!disposed) { reset(); }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('literate.languageServers')) { reset(); }
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => reset()),
    vscode.workspace.onDidChangeTextDocument(invalidate), vscode.workspace.onDidOpenTextDocument(invalidate),
    vscode.workspace.onDidCloseTextDocument(invalidate));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.literate');
    context.subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
    async function request(document: vscode.TextDocument, cursor: vscode.Position, token: vscode.CancellationToken,
        method: 'hover' | 'completion'): Promise<vscode.Hover | vscode.CompletionItem[] | undefined> {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (disposed || busy || token.isCancellationRequested || !folder || !local(folder, document)) { return undefined; }
        const configured = servers(invalid), fingerprint = JSON.stringify(configured);
        if (!Object.keys(configured).length) { return undefined; }
        const revision = epoch, version = document.version;
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        active = controller; busy = true;
        let session: Session | undefined, sessionKey = '', phase = 'snapshot';
        const fresh = (): boolean => !disposed && !controller.signal.aborted && !token.isCancellationRequested
            && epoch === revision && document.version === version && local(folder, document)
            && JSON.stringify(servers()) === fingerprint;
        try {
            if (!fresh()) { return undefined; }
            const documents = await snapshot(folder);
            if (!fresh()) { return undefined; }
            const sourcePath = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
            if (!documents.some(source => source.path.replace(/^\.\//, '') === sourcePath && source.text === document.getText())) {
                return undefined;
            }
            const projected = projectLanguageSources(documents);
            if (projected.diagnostics.length) { return undefined; }
            const hit = mapSourcePosition(projected.files, sourcePath, document.offsetAt(cursor));
            if (!hit) { return undefined; }
            const id = language(hit.file.language), config = configured[id];
            if (!config) { return undefined; }
            sessionKey = JSON.stringify([folder.uri.toString(), id]);
            session = sessions.get(sessionKey);
            if (session?.failed) { return undefined; }
            if (!session) {
                session = { client: new LanguageClient({ ...config, cwd: folder.uri.fsPath, rootUri: folder.uri.toString() }), failed: false };
                sessions.set(sessionKey, session);
            }
            const client = session.client;
            const uri = (name: string): string => vscode.Uri.file(path.resolve(folder.uri.fsPath, name)).toString();
            phase = 'initialization';
            await client.initialize();
            if (!fresh()) { return undefined; }
            const capability = client.capabilities[method === 'hover' ? 'hoverProvider' : 'completionProvider'];
            if (!(object(capability) || (method === 'hover' && capability === true))) { return undefined; }
            phase = 'synchronization';
            await client.sync(projected.files.filter(file => language(file.language) === id || (family(id) && family(language(file.language))))
                .map(file => ({ uri: uri(file.path), languageId: language(file.language), text: file.content })));
            if (!fresh()) { return undefined; }
            phase = 'request';
            const reply = await client.request('textDocument/' + method, {
                textDocument: { uri: uri(hit.file.path) }, position: position(hit.file.content, hit.offset),
                ...(method === 'completion' ? { context: { triggerKind: 1 } } : {})
            }, controller.signal);
            if (!fresh()) { return undefined; }
            const view = { document, position: cursor, hit };
            return method === 'hover' ? hover(view, reply) : completions(view, reply);
        } catch {
            if (session && sessions.get(sessionKey) === session && !session.failed
                && !(phase === 'request' && controller.signal.aborted)) {
                session.failed = true; close(session.client);
                report('Language server ' + phase + ' failed. Check the executable and global literate.languageServers '
                    + 'settings, then run literate.restartLanguageServers to retry. Server details are withheld.');
            }
            return undefined;
        } finally { cancellation.dispose(); active = undefined; busy = false; }
    }
    const selector: vscode.DocumentSelector = { scheme: 'file', language: 'markdown', pattern: '**/*.literate' };
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        provideHover: (document, cursor, token) => request(document, cursor, token, 'hover') as Promise<vscode.Hover | undefined>
    }), vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems: (document, cursor, token, completionContext) => {
            if (completionContext.triggerKind !== vscode.CompletionTriggerKind.Invoke) { return undefined; }
            return request(document, cursor, token, 'completion') as Promise<vscode.CompletionItem[] | undefined>;
        }
    }));
}
