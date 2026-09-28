import * as vscode from 'vscode';
import * as path from 'node:path';
import type { SourceDocument } from './engine';
import type { LanguageProjection } from './language-projection';

/** Immutable snapshot, including nested arrays and records; replace the context on change. */
export interface LanguageLocationContext {
    root: vscode.Uri;
    files: LanguageProjection[];
    documents: SourceDocument[];
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const coordinate = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
interface Point { line: number; character: number; }
interface Span { start: Point; end: Point; }
const compare = (a: Point, b: Point): number => a.line - b.line || a.character - b.character;
function point(value: unknown): value is Point {
    return record(value) && coordinate(value.line) && coordinate(value.character);
}
function span(value: unknown): value is Span {
    return record(value) && point(value.start) && point(value.end) && compare(value.start, value.end) <= 0;
}
function range(value: Span): vscode.Range {
    return new vscode.Range(new vscode.Position(value.start.line, value.start.character),
        new vscode.Position(value.end.line, value.end.character));
}
function key(location: vscode.Location): string {
    const { start, end } = location.range;
    return JSON.stringify([location.uri.toString(), start.line, start.character, end.line, end.character]);
}
function localUri(value: unknown): vscode.Uri | undefined {
    if (typeof value !== 'string' || !/^file:\//i.test(value) || /[?#\\\x00-\x20\x7f]/.test(value)) { return; }
    const body = value.slice(5);
    if (body.startsWith('//') && !body.startsWith('///')) { return; }
    try {
        const decoded = decodeURIComponent(body);
        if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('////')) { return; }
        const uri = vscode.Uri.parse(value, true);
        if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment
            || !path.isAbsolute(uri.fsPath) || uri.fsPath.startsWith('//')) { return; }
        return vscode.Uri.file(path.normalize(uri.fsPath));
    } catch { return; }
}
class TextIndex {
    readonly starts = [0];
    readonly ends: number[] = [];
    constructor(readonly text: string) {
        for (const match of text.matchAll(/\r\n|\r|\n/g)) {
            this.ends.push(match.index!);
            this.starts.push(match.index! + match[0].length);
        }
        this.ends.push(text.length);
    }
    offset(value: Point): number | undefined {
        const start = this.starts[value.line], end = this.ends[value.line];
        return start !== undefined && value.character <= end - start ? start + value.character : undefined;
    }
    offsets(value: Span): [number, number] | undefined {
        const start = this.offset(value.start), end = this.offset(value.end);
        return start !== undefined && end !== undefined ? [start, end] : undefined;
    }
    position(offset: number): vscode.Position {
        let low = 0, high = this.starts.length;
        while (low + 1 < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.starts[middle] <= offset) { low = middle; } else { high = middle; }
        }
        return new vscode.Position(low, Math.min(offset, this.ends[low]) - this.starts[low]);
    }
}
interface Source { uri: vscode.Uri; index: TextIndex; }
interface Prepared {
    files: Map<string, LanguageProjection>;
    sources: Map<string, Source>;
    documents: Map<string, Source>;
    indexes: Map<LanguageProjection, TextIndex>;
}
const preparedContexts = new WeakMap<LanguageLocationContext, Prepared>();
function prepare(context: LanguageLocationContext): Prepared | undefined {
    const cached = preparedContexts.get(context);
    if (cached) { return cached; }
    const root = localUri(context.root.toString());
    if (!root) { return; }
    const result: Prepared = { files: new Map(), sources: new Map(), documents: new Map(), indexes: new Map() };
    const resolve = (relative: string): vscode.Uri | undefined => localUri(vscode.Uri.file(path.resolve(root.fsPath, relative)).toString());
    for (const file of context.files) {
        const uri = resolve(file.path);
        if (uri) { result.files.set(uri.fsPath, file); }
    }
    for (const document of context.documents) {
        const uri = resolve(document.path);
        if (!uri) { continue; }
        const source = { uri, index: new TextIndex(document.text) };
        result.sources.set(document.path, source);
        result.documents.set(uri.fsPath, source);
    }
    preparedContexts.set(context, result);
    return result;
}
interface Intersection { source: Source; start: number; end: number; from: number; to: number; }
function connected(a: Intersection, b: Intersection): boolean {
    if (a.source !== b.source || a.to !== b.from) { return false; }
    return a.end === b.start || (b.start === a.end + 1
        && a.source.index.text.slice(a.end, b.start + 1) === '\r\n');
}
function intersection(file: LanguageProjection, mapping: LanguageProjection['mappings'][number],
    start: number, end: number, state: Prepared): Intersection | undefined {
    const source = state.sources.get(mapping.sourcePath);
    if (!source || ![mapping.sourceStart, mapping.sourceEnd, mapping.generatedStart, mapping.generatedEnd].every(coordinate)
        || mapping.sourceEnd > source.index.text.length || mapping.generatedEnd > file.content.length
        || mapping.sourceEnd - mapping.sourceStart !== mapping.generatedEnd - mapping.generatedStart
        || mapping.sourceStart > mapping.sourceEnd || mapping.generatedStart > mapping.generatedEnd) { return; }
    const from = Math.max(start, mapping.generatedStart), to = Math.min(end, mapping.generatedEnd);
    if (start === end) {
        if (from !== start || to !== end || (start === mapping.generatedEnd && !mapping.endCursor)) { return; }
    } else if (from >= to) { return; }
    return { source, from, to, start: mapping.sourceStart + from - mapping.generatedStart,
        end: mapping.sourceStart + to - mapping.generatedStart };
}
function location(hit: Intersection): vscode.Location {
    return new vscode.Location(hit.source.uri, new vscode.Range(
        hit.source.index.position(hit.start), hit.source.index.position(hit.end)));
}
function mapped(file: LanguageProjection, bounds: [number, number], state: Prepared, limit: number): vscode.Location[] {
    const result: vscode.Location[] = [], seen = new Set<string>();
    let pending: Intersection | undefined;
    const flush = (): void => {
        if (!pending) { return; }
        const value = location(pending), id = key(value);
        if (!seen.has(id)) { seen.add(id); result.push(value); }
    };
    for (const mapping of file.mappings) {
        const next = intersection(file, mapping, bounds[0], bounds[1], state);
        if (!next) { continue; }
        if (pending && connected(pending, next)) { pending.end = next.end; pending.to = next.to; continue; }
        flush();
        if (result.length >= limit) { return result; }
        pending = next;
    }
    flush();
    return result;
}
function mapRange(uri: vscode.Uri, value: Span, state: Prepared, limit: number): vscode.Location[] {
    const file = state.files.get(uri.fsPath);
    if (file) {
        let index = state.indexes.get(file);
        if (!index) { index = new TextIndex(file.content); state.indexes.set(file, index); }
        const bounds = index.offsets(value);
        return bounds ? mapped(file, bounds, state, limit) : [];
    }
    const source = state.documents.get(uri.fsPath);
    if (source && !source.index.offsets(value)) { return []; }
    return [new vscode.Location(uri, range(value))];
}
function validTargetRange(uri: vscode.Uri, value: Span, state: Prepared): boolean {
    const file = state.files.get(uri.fsPath);
    if (file) {
        let index = state.indexes.get(file);
        if (!index) { index = new TextIndex(file.content); state.indexes.set(file, index); }
        return !!index.offsets(value);
    }
    const source = state.documents.get(uri.fsPath);
    return !source || !!source.index.offsets(value);
}
function target(value: unknown, state: Prepared): { uri: vscode.Uri; range: Span } | undefined {
    if (!record(value)) { return; }
    const link = 'targetUri' in value;
    const uri = localUri(link ? value.targetUri : value.uri);
    const outer = link ? value.targetRange : value.range;
    if (!uri || !span(outer) || !validTargetRange(uri, outer, state)) { return; }
    const selection = link && value.targetSelectionRange !== undefined ? value.targetSelectionRange : outer;
    if (!span(selection) || compare(selection.start, outer.start) < 0 || compare(selection.end, outer.end) > 0) { return; }
    return { uri, range: selection };
}
export function mapLanguageLocations(reply: unknown, context: LanguageLocationContext): vscode.Location[] {
    const state = prepare(context);
    if (!state) { return []; }
    const entries = Array.isArray(reply) ? reply : [reply];
    const result: vscode.Location[] = [], seen = new Set<string>();
    for (let index = 0; index < Math.min(entries.length, 1000); index++) {
        const value = target(entries[index], state);
        if (!value) { continue; }
        for (const mappedLocation of mapRange(value.uri, value.range, state, 1)) {
            const id = key(mappedLocation);
            if (!seen.has(id)) { seen.add(id); result.push(mappedLocation); }
        }
    }
    return result;
}
export function mapLanguageDiagnosticRange(uri: string, value: unknown, context: LanguageLocationContext): vscode.Location[] {
    if (!span(value)) { return []; }
    const targetUri = localUri(uri), state = prepare(context);
    return targetUri && state ? mapRange(targetUri, value, state, 100) : [];
}
