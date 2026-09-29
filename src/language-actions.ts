import * as vscode from 'vscode';
import type { LanguageProjection, ProjectionMapping } from './language-projection';
import { mapGeneratedRange } from './language-projection';

export interface LanguageCodeActionContext {
    document: vscode.TextDocument;
    sourcePath: string;
    generatedUri: vscode.Uri;
    file: LanguageProjection;
    mapping: ProjectionMapping;
    requestVersion: number;
    triggerKind: vscode.CodeActionTriggerKind;
}
type Value = Record<string, unknown>;
interface Point { line: number; character: number; }
interface Span { start: Point; end: Point; }
interface ParsedEdit { start: number; end: number; range: vscode.Range; newText: string; }
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function point(value: unknown): value is Point {
    return object(value) && integer(value.line) && integer(value.character);
}
function span(value: unknown): value is Span {
    return object(value) && point(value.start) && point(value.end)
        && (value.start.line < value.end.line
            || value.start.line === value.end.line && value.start.character <= value.end.character);
}
function generatedOffset(text: string, value: Point): number | undefined {
    let line = 0, start = 0;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        if (line === value.line) {
            return value.character <= match.index! - start ? start + value.character : undefined;
        }
        line++;
        start = match.index! + match[0].length;
    }
    return line === value.line && value.character <= text.length - start ? start + value.character : undefined;
}
function fresh(context: LanguageCodeActionContext): boolean {
    const { document, file, mapping } = context;
    return context.triggerKind === vscode.CodeActionTriggerKind.Invoke
        && integer(context.requestVersion) && document.version === context.requestVersion && !document.isClosed
        && context.sourcePath === mapping.sourcePath && file.mappings.includes(mapping)
        && file.mappings.filter(value => value.sourcePath === mapping.sourcePath
            && value.sourceStart === mapping.sourceStart && value.sourceEnd === mapping.sourceEnd).length === 1
        && [mapping.sourceStart, mapping.sourceEnd, mapping.generatedStart, mapping.generatedEnd].every(integer)
        && mapping.sourceStart <= mapping.sourceEnd && mapping.generatedStart <= mapping.generatedEnd
        && mapping.sourceEnd <= document.getText().length && mapping.generatedEnd <= file.content.length
        && mapping.sourceEnd - mapping.sourceStart === mapping.generatedEnd - mapping.generatedStart
        && document.getText().slice(mapping.sourceStart, mapping.sourceEnd)
            === file.content.slice(mapping.generatedStart, mapping.generatedEnd)
        && context.generatedUri.scheme === 'file' && !context.generatedUri.authority;
}
function mappedRange(value: unknown, context: LanguageCodeActionContext): ParsedEdit | undefined {
    if (!span(value)) { return; }
    const start = generatedOffset(context.file.content, value.start);
    const end = generatedOffset(context.file.content, value.end);
    if (start === undefined || end === undefined) { return; }
    const mapped = mapGeneratedRange(context.file, start, end, context.mapping);
    if (!mapped) { return; }
    return { start: mapped.start, end: mapped.end,
        range: new vscode.Range(context.document.positionAt(mapped.start), context.document.positionAt(mapped.end)), newText: '' };
}
function edits(value: unknown, context: LanguageCodeActionContext): ParsedEdit[] | undefined {
    if (!object(value) || Object.keys(value).some(key => key !== 'changes') || !object(value.changes)) { return; }
    const entries = Object.entries(value.changes);
    if (entries.length !== 1 || entries[0][0] !== context.generatedUri.toString() || !Array.isArray(entries[0][1])) { return; }
    const raw = entries[0][1];
    if (!raw.length || raw.length > 1000) { return; }
    const result: ParsedEdit[] = [];
    let replacementSize = 0;
    for (const entry of raw) {
        if (!object(entry) || Object.keys(entry).some(key => key !== 'range' && key !== 'newText')
            || typeof entry.newText !== 'string') { return; }
        replacementSize += entry.newText.length;
        if (replacementSize > 1024 * 1024) { return; }
        const mapped = mappedRange(entry.range, context);
        if (!mapped) { return; }
        mapped.newText = entry.newText;
        result.push(mapped);
    }
    return safeOrder(result);
}
function safeOrder(values: ParsedEdit[]): ParsedEdit[] | undefined {
    values.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < values.length; index++) {
        const previous = values[index - 1], current = values[index];
        if (current.start < previous.end || current.start === previous.start) { return; }
    }
    return values;
}
function diagnostics(value: unknown, context: LanguageCodeActionContext): vscode.Diagnostic[] | undefined {
    if (value === undefined) { return []; }
    if (!Array.isArray(value) || value.length > 100) { return; }
    const result: vscode.Diagnostic[] = [];
    for (const raw of value) {
        if (!object(raw) || Object.keys(raw).some(key => !['range', 'message', 'severity', 'code', 'source', 'tags'].includes(key))
            || typeof raw.message !== 'string' || raw.message.length > 8192
            || (raw.source !== undefined && (typeof raw.source !== 'string' || raw.source.length > 256))
            || (raw.code !== undefined && typeof raw.code !== 'string' && !Number.isSafeInteger(raw.code))
            || (raw.code !== undefined && String(raw.code).length > 256)) { return; }
        const mapped = mappedRange(raw.range, context);
        if (!mapped) { return; }
        const severity = raw.severity === undefined ? vscode.DiagnosticSeverity.Error
            : integer(raw.severity) && raw.severity >= 1 && raw.severity <= 4 ? raw.severity - 1 : undefined;
        if (severity === undefined) { return; }
        const diagnostic = new vscode.Diagnostic(mapped.range, raw.message, severity);
        if (typeof raw.source === 'string' && raw.source.length <= 256) { diagnostic.source = raw.source; }
        if ((typeof raw.code === 'string' || typeof raw.code === 'number') && String(raw.code).length <= 256) { diagnostic.code = raw.code; }
        if (raw.tags !== undefined) {
            if (!Array.isArray(raw.tags) || raw.tags.some(tag => tag !== 1 && tag !== 2)) { return; }
            diagnostic.tags = raw.tags as vscode.DiagnosticTag[];
        }
        result.push(diagnostic);
    }
    return result;
}
function action(value: unknown, context: LanguageCodeActionContext): vscode.CodeAction | undefined {
    if (!object(value) || 'command' in value || 'disabled' in value
        || typeof value.title !== 'string' || !value.title.length || value.title.length > 4096
        || (value.kind !== undefined && (typeof value.kind !== 'string' || value.kind.length > 256
            || !/^(?:quickfix|refactor)(?:\.[\w-]+)*$/.test(value.kind)))
        || (value.isPreferred !== undefined && typeof value.isPreferred !== 'boolean')) { return; }
    const converted = edits(value.edit, context);
    if (!converted) { return; }
    const result = new vscode.CodeAction(value.title,
        typeof value.kind === 'string' ? vscode.CodeActionKind.Empty.append(value.kind) : undefined);
    const workspace = new vscode.WorkspaceEdit();
    for (const edit of converted) { workspace.replace(context.document.uri, edit.range, edit.newText); }
    result.edit = workspace;
    if (typeof value.isPreferred === 'boolean') { result.isPreferred = value.isPreferred; }
    if (value.diagnostics !== undefined) {
        const attached = diagnostics(value.diagnostics, context);
        if (attached) { result.diagnostics = attached; }
    }
    return result;
}
export function mapLanguageCodeActions(reply: unknown, context: LanguageCodeActionContext): vscode.CodeAction[] {
    if (!fresh(context) || reply === null || reply === undefined) { return []; }
    if (!Array.isArray(reply) || reply.length > 1000) { return []; }
    const result: vscode.CodeAction[] = [];
    for (const value of reply) {
        const converted = action(value, context);
        if (!converted) { return []; }
        result.push(converted);
    }
    return result;
}
