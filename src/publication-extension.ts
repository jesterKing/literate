import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { discoveryExcludedDirectories, safeRelativePath } from './engine';
import type { SourceDocument } from './engine';

type Kind = 'latex' | 'pdf';
interface Choice { paper: string; margins: string; destination: string; }
export interface PublicationRequest { args: string[]; documents: SourceDocument[]; }
export interface HelperResult { stdout: string; stderr: string; }
export type PublicationQueue = <T>(operation: () => Promise<T>) => Promise<T>;
export type PublicationBridge = (node: string, helper: string, root: string,
    request: PublicationRequest, token: vscode.CancellationToken,
    report: (message: string) => void) => Promise<HelperResult>;
const papers: Record<string, [number, number]> = {
    a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4], legal: [215.9, 355.6]
};
const excluded = new Set(discoveryExcludedDirectories);
const inputLimit = 32 * 1024 * 1024;
const outputLimit = 8 * 1024 * 1024;
let publishing = false;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function cancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) { throw new Error('Publication cancelled'); }
}
function allowed(folder?: vscode.WorkspaceFolder): void {
    if (!vscode.workspace.isTrusted) { throw new Error('Publication requires Workspace Trust.'); }
    if (vscode.env.remoteName || vscode.env.uiKind === vscode.UIKind.Web) {
        throw new Error('Publication requires a local desktop workspace, not remote or web.');
    }
    if (process.platform === 'win32') { throw new Error('Publication currently requires POSIX.'); }
    if (folder && (folder.uri.scheme !== 'file' || folder.uri.authority ||
        !vscode.workspace.workspaceFolders?.some(item => item.uri.toString() === folder.uri.toString()))) {
        throw new Error('Publication requires a current local file workspace folder.');
    }
}
export function validateMargins(paper: string, value: string): string | undefined {
    const parts = value.split(',').map(part => part.trim());
    const values = parts.map(Number);
    if (parts.length !== 4 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part)) ||
        values.some(value => !Number.isFinite(value) || value < 5 || value > 50)) {
        return 'Enter four numbers in mm: top,right,bottom,left (each 5–50).';
    }
    const size = papers[paper];
    if (!size || size[0] - values[1] - values[3] < 80 || size[1] - values[0] - values[2] < 100) {
        return 'Margins must leave at least an 80 × 100 mm body.';
    }
    return undefined;
}
function relativePath(root: string, target: string): string {
    const relative = path.relative(root, target).split(path.sep).join('/');
    const safe = safeRelativePath(relative);
    if (!safe || safe !== relative) { throw new Error(`Path must be inside the selected root: ${target}`); }
    return safe;
}
async function checkPath(root: string, relative: string): Promise<void> {
    let current = root;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
            throw new Error(`Unsafe publication path (symlink or non-file): ${current}`);
        }
        if (await fs.realpath(current) !== current) { throw new Error(`Noncanonical path: ${current}`); }
    }
}
async function canonicalRoot(folder: vscode.WorkspaceFolder): Promise<string> {
    allowed(folder);
    const root = path.resolve(folder.uri.fsPath);
    if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) {
        throw new Error('Publication root must be a real, canonical directory, not a symlink.');
    }
    return root;
}
export async function capturePublicationSnapshot(root: string, token: vscode.CancellationToken): Promise<SourceDocument[]> {
    cancelled(token);
    const overlays = new Map<string, string>();
    for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== 'file' || document.uri.authority) { continue; }
        const relative = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
        if (!relative.endsWith('.literate') || relative.startsWith('../') || path.isAbsolute(relative)) { continue; }
        if (relative.split('/').slice(0, -1).some(part => excluded.has(part))) { continue; }
        const safe = relativePath(root, document.uri.fsPath);
        overlays.set(safe, document.getText());
    }
    const documents = new Map<string, string>();
    let bytes = 0;
    const add = (name: string, text: string): void => {
        bytes += Buffer.byteLength(JSON.stringify({ path: name, text })) + 1;
        if (bytes > inputLimit) { throw new Error('Publication snapshot exceeds 32 MiB.'); }
        documents.set(name, text);
    };
    for (const [name, text] of overlays) {
        cancelled(token);
        await checkPath(root, name);
        add(name, text);
    }
    const visit = async (directory: string): Promise<void> => {
        cancelled(token);
        const absolute = path.join(root, directory);
        if (await fs.realpath(absolute) !== absolute) { throw new Error(`Noncanonical source directory: ${absolute}`); }
        const entries = await fs.readdir(absolute, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            cancelled(token);
            if (entry.isSymbolicLink()) { continue; }
            const name = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.isDirectory() && !excluded.has(entry.name)) { await visit(name); }
            else if (entry.isFile() && name.endsWith('.literate') && !overlays.has(name)) {
                relativePath(root, path.join(root, name));
                await checkPath(root, name);
                if ((await fs.stat(path.join(root, name))).size > inputLimit) {
                    throw new Error(`Publication source exceeds 32 MiB: ${name}`);
                }
                add(name, await fs.readFile(path.join(root, name), 'utf8'));
            }
        }
    };
    await visit('');
    cancelled(token);
    return [...documents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, text]) => ({ path: name, text }));
}
export const runPublicationHelper: PublicationBridge = (node, helper, root, request, token, report) => {
    cancelled(token);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > inputLimit) { throw new Error('Publication request exceeds 32 MiB.'); }
    return new Promise((resolve, reject) => {
        const child = spawn(node, [helper], { cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let bytes = 0, failure: string | undefined, stopped = false;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason?: string): void => {
            failure ??= reason;
            if (stopped) { return; }
            stopped = true;
            if (!child.kill('SIGTERM')) { report('Unable to deliver SIGTERM; waiting for helper exit.'); }
            grace = setTimeout(() => report('Helper has not acknowledged cancellation. Waiting for transaction cleanup; publication remains locked.'), 30000);
        };
        const timer = setTimeout(() => stop('Publication exceeded the 10 minute execution deadline.'), 600000);
        const subscription = token.onCancellationRequested(() => stop());
        const collect = (chunks: Buffer[], chunk: Buffer): void => {
            bytes += chunk.length;
            if (bytes > outputLimit) { stop('Publication helper output exceeds 8 MiB.'); }
            else { chunks.push(chunk); }
        };
        child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
        child.on('error', error => { failure ??= `Cannot run publication Node: ${message(error)}`; });
        child.stdin.on('error', error => stop(`Cannot send publication snapshot: ${message(error)}`));
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (grace) { clearTimeout(grace); }
            subscription.dispose();
            const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
            if (failure || code !== 0 || signal) {
                reject(new Error([failure ?? `Publication helper exited ${code ?? signal}.`, result.stdout, result.stderr]
                    .filter(Boolean).join('\n')));
            } else {
                try {
                    publicationWarnings(result, request.args[0], request.args[request.args.indexOf('--output') + 1]);
                    resolve(result);
                } catch (error) { reject(error); }
            }
        });
        if (token.isCancellationRequested) { stop(); }
        if (!stopped) { child.stdin.end(input); }
        else { child.stdin.end(); }
    });
};
function publicationWarnings(result: HelperResult, kind: string, destination: string): string[] {
    let response;
    try { response = JSON.parse(result.stdout); }
    catch { throw new Error(`Invalid JSON from publication helper:\n${result.stdout}`); }
    if (response?.schemaVersion !== 1 || response.command !== kind || response.ok !== true ||
        !Array.isArray(response.outputs) || !response.outputs.some((item: { path?: string; status?: string }) =>
            item?.path === destination && ['written', 'current'].includes(item.status ?? ''))) {
        throw new Error(`Publication did not report successful output:\n${result.stdout}`);
    }
    const warnings: unknown = response.publication?.warnings;
    return Array.isArray(warnings) ? warnings.map(String) : [];
}
async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    allowed();
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active && vscode.workspace.getWorkspaceFolder(active);
    if (folder) { allowed(folder); return folder; }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { throw new Error('Open a local project folder before exporting.'); }
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({
        label: folder.name, description: folder.uri.fsPath, folder
    })), { placeHolder: 'Select publication project folder' });
    if (choice) { allowed(choice.folder); }
    return choice?.folder;
}
function executable(name: string, required: boolean): string | undefined {
    const value = vscode.workspace.getConfiguration('literate.publication').inspect<string>(name)?.globalValue;
    if (value === undefined || value === '') {
        if (required) { throw new Error(`Set literate.publication.${name} in User settings to an absolute external Node >=22.12 executable (not Electron).`); }
        return undefined;
    }
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
        throw new Error(`literate.publication.${name} must be an explicit absolute executable path in User settings.`);
    }
    return value;
}
async function chooseOutput(root: string, kind: Kind, previous?: Choice): Promise<Choice | undefined> {
    const names = Object.keys(papers);
    if (previous && names.includes(previous.paper)) { names.splice(names.indexOf(previous.paper), 1); names.unshift(previous.paper); }
    const paper = await vscode.window.showQuickPick(names, { placeHolder: 'Publication page size' });
    if (paper === undefined) { return undefined; }
    const margins = await vscode.window.showInputBox({ prompt: 'Margins in mm: top,right,bottom,left (5–50 each)',
        value: previous?.margins ?? '20,20,20,20', validateInput: value => validateMargins(paper, value) });
    if (margins === undefined) { return undefined; }
    const error = validateMargins(paper, margins);
    if (error) { throw new Error(error); }
    const extension = kind === 'latex' ? 'tex' : 'pdf';
    const remembered = previous?.destination;
    const destination = remembered && safeRelativePath(remembered) === remembered && remembered.endsWith(`.${extension}`)
        ? remembered : `publication.${extension}`;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, destination)),
        filters: { [extension.toUpperCase()]: [extension] }, title: 'Export publication inside the selected project' });
    if (!uri) { return undefined; }
    if (uri.scheme !== 'file' || uri.authority || !uri.fsPath.endsWith(`.${extension}`)) {
        throw new Error(`Choose a local .${extension} file inside the selected project.`);
    }
    const relative = relativePath(root, uri.fsPath);
    await checkPath(root, relative);
    return { paper, margins: margins.split(',').map(value => value.trim()).join(','), destination: relative };
}
export function registerPublicationCommands(context: vscode.ExtensionContext,
    serialize: PublicationQueue = operation => operation(), bridge: PublicationBridge = runPublicationHelper): void {
    const output = vscode.window.createOutputChannel('Literate Publication');
    let disposed = false;
    let active: { source: vscode.CancellationTokenSource; folder?: vscode.WorkspaceFolder; revoked?: string } | undefined;
    const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(event => {
        if (active?.folder && event.removed.some(folder => folder.uri.toString() === active!.folder!.uri.toString())) {
            active.revoked = 'Selected workspace folder was removed.';
            active.source.cancel();
        }
    });
    const execute = async (kind: Kind): Promise<void> => {
        if (disposed) { return; }
        if (publishing) {
            await vscode.window.showWarningMessage('A publication is already in progress. Wait for it to finish.');
            return;
        }
        publishing = true;
        const operation: NonNullable<typeof active> = { source: new vscode.CancellationTokenSource() };
        active = operation;
        const token = operation.source.token;
        let completed: string | undefined;
        const authority = (): void => {
            if (disposed) { throw new Error('Publication registration was disposed.'); }
            if (operation.revoked) { throw new Error(operation.revoked); }
            allowed(operation.folder);
        };
        try {
            const folder = await chooseFolder();
            if (!folder) { return; }
            operation.folder = folder;
            cancelled(token);
            authority();
            const root = await canonicalRoot(folder);
            const key = `literate.publication:${kind}:${root}`;
            const choice = await chooseOutput(root, kind, context.workspaceState.get<Choice>(key));
            if (!choice) { return; }
            cancelled(token);
            authority();
            const node = executable('nodePath', true)!;
            const browser = executable('browserPath', false);
            const manifest = vscode.workspace.getConfiguration('literate.publication', folder.uri).get<string>('fontManifest');
            if (manifest && (typeof manifest !== 'string' || safeRelativePath(manifest) !== manifest)) {
                throw new Error('literate.publication.fontManifest must be a safe root-relative JSON path.');
            }
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: `Export ${kind === 'latex' ? 'LaTeX' : 'PDF'}`, cancellable: true }, async (progress, progressToken) => {
                const forwarding = progressToken.onCancellationRequested(() => operation.source.cancel());
                if (progressToken.isCancellationRequested) { operation.source.cancel(); }
                try {
                    await serialize(async () => {
                        cancelled(token);
                        await canonicalRoot(folder);
                        authority();
                        const documents = await capturePublicationSnapshot(root, token);
                        const args = [kind, root, '--output', choice.destination, '--paper', choice.paper];
                        ['top', 'right', 'bottom', 'left'].forEach((side, index) => {
                            args.push(`--margin-${side}`, `${choice.margins.split(',')[index]}mm`);
                        });
                        if (browser) { args.push('--browser', browser); }
                        if (manifest) { await checkPath(root, manifest); args.push('--font-manifest', manifest); }
                        args.push('--json');
                        await canonicalRoot(folder);
                        await checkPath(root, choice.destination);
                        authority();
                        cancelled(token);
                        const result = await bridge(node, context.asAbsolutePath('out/publication-helper.cjs'), root,
                            { args, documents }, token, text => { output.appendLine(text); progress.report({ message: text }); });
                        if (result.stderr) { output.appendLine(result.stderr); }
                        const warnings = publicationWarnings(result, kind, choice.destination);
                        completed = path.join(root, choice.destination);
                        output.appendLine(`Publication completed: ${completed}`);
                        for (const warning of warnings) { output.appendLine(`Warning: ${warning}`); }
                    });
                } finally { forwarding.dispose(); }
            });
            authority();
            await context.workspaceState.update(key, choice);
            authority();
            const action = await vscode.window.showInformationMessage(`Exported ${choice.destination}`, 'Open Output');
            if (action === 'Open Output') {
                authority();
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, choice.destination)));
            }
        } catch (error) {
            const detail = completed
                ? `Publication completed: ${completed}. ${message(error)} No further success actions will be taken.`
                : `Publication failed: ${message(error)}`;
            output.appendLine(detail);
            if (!disposed) {
                output.show(true);
                if (completed) { await vscode.window.showWarningMessage(detail.slice(0, 1500)); }
                else { await vscode.window.showErrorMessage(detail.slice(0, 1500)); }
            }
        } finally {
            operation.source.dispose();
            active = undefined;
            publishing = false;
            if (disposed) { output.dispose(); }
        }
    };
    const commands = ([['literate.exportLatex', 'latex'], ['literate.exportPdf', 'pdf']] as const)
        .map(([command, kind]) => vscode.commands.registerCommand(command, () => execute(kind)));
    context.subscriptions.push({ dispose(): void {
        if (disposed) { return; }
        disposed = true;
        foldersChanged.dispose();
        for (const command of commands) { command.dispose(); }
        active?.source.cancel();
        if (!active) { output.dispose(); }
    } });
}
