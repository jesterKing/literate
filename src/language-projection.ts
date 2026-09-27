import { collectLanguageProject, GenerationDiagnostic, safeRelativePath, SourceDocument } from './engine';

export interface ProjectionMapping {
    sourcePath: string;
    sourceStart: number;
    sourceEnd: number;
    generatedStart: number;
    generatedEnd: number;
    endCursor: boolean;
}
export interface LanguageProjection {
    path: string;
    language: string;
    content: string;
    mappings: ProjectionMapping[];
}
export interface SourceProjectionPosition {
    file: LanguageProjection;
    offset: number;
    mapping: ProjectionMapping;
}
interface Piece { text: string; path?: string; start: number; endCursor: boolean; }
export function projectLanguageSources(documents: SourceDocument[], templates: Record<string, string> = {}): {
    files: LanguageProjection[]; diagnostics: GenerationDiagnostic[];
} {
    const graph = collectLanguageProject(documents, templates);
    const diagnostics = graph.parsed.diagnostics;
    const files: LanguageProjection[] = [];
    const report = (message: string): void => {
        diagnostics.push({ path: graph.parsed.documents[0]?.path || '', line: 0, column: 0, message });
    };
    const segmentLimit = 200000;
    let bytes = 0, segments = 0;
    const emit = (into: Piece[], piece: Piece): void => {
        bytes += piece.text.length * 2;
        if (bytes > 8 * 1024 * 1024 || ++segments > segmentLimit) { throw new Error('Language projection expansion limit exceeded'); }
        into.push(piece);
    };
    const sources = new Map(graph.parsed.documents.map(document => [document.path, document.source]));
    const lines = new Map(Array.from(sources, ([path, text]) => {
        const starts = [0];
        for (const match of text.matchAll(/\r\n|\r|\n/g)) { starts.push(match.index! + match[0].length); }
        return [path, starts] as const;
    }));
    type Fragment = NonNullable<ReturnType<typeof graph.fragments.get>>;
    type Part = Fragment['parts'][number];
    const done = new Set<string>(), active = new Set<string>();
    for (const name of graph.fragments.keys()) {
        const stack = [{ name, leave: false, at: graph.fragments.get(name)!.location }];
        while (stack.length) {
            const frame = stack.pop()!;
            if (frame.leave) { active.delete(frame.name); done.add(frame.name); continue; }
            if (active.has(frame.name)) { diagnostics.push({ ...frame.at, message: `Fragment cycle: ${frame.name}` }); continue; }
            if (done.has(frame.name)) { continue; }
            const fragment = graph.fragments.get(frame.name);
            if (!fragment) { diagnostics.push({ ...frame.at, message: `Missing fragment: ${frame.name}`, code: 'missing-fragment' }); continue; }
            active.add(frame.name);
            stack.push({ ...frame, leave: true });
            for (const part of [...fragment.parts].reverse()) {
                for (const ref of [...graph.references(part)].reverse()) {
                    if (ref.modifier) { diagnostics.push({ ...ref.at, message: `Invalid definition operator on reference: ${ref.name}` }); }
                    stack.push({ name: ref.name, leave: false, at: ref.at });
                }
            }
        }
    }
    if (diagnostics.length) { return { files: [], diagnostics }; }
    interface LiteralLine { offset: number; body: string; lineStart: number; original: string; suffix: number; }
    const literalLines = new Map<Part, LiteralLine[]>();
    function prepare(part: Part): LiteralLine[] {
        const cached = literalLines.get(part);
        if (cached) { return cached; }
        const source = sources.get(part.location.path)!, starts = lines.get(part.location.path)!;
        const result: LiteralLine[] = [];
        let offset = 0;
        for (const [index, body] of part.content.split('\n').entries()) {
            const lineStart = starts[part.location.line + index];
            if (lineStart === undefined) { break; }
            const original = source.slice(lineStart, starts[part.location.line + index + 1]).replace(/[\r\n]+$/, '');
            let suffix = 0;
            while (suffix < Math.min(body.length, original.length)
                && body[body.length - suffix - 1] === original[original.length - suffix - 1]) { suffix++; }
            result.push({ offset, body, lineStart, original, suffix });
            offset += body.length + 1;
        }
        literalLines.set(part, result);
        return result;
    }
    function literal(part: Part, from: number, to: number, into: Piece[]): void {
        const source = sources.get(part.location.path)!, records = prepare(part);
        if (!part.content && lines.get(part.location.path)![part.location.line] === source.length) {
            emit(into, { text: '', path: part.location.path, start: source.length, endCursor: true });
        }
        let low = 0, high = records.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (records[mid].offset + records[mid].body.length < from) { low = mid + 1; }
            else { high = mid; }
        }
        for (let index = low; index < records.length && records[index].offset < to; index++) {
            const { offset, body, lineStart, original, suffix } = records[index];
            const a = Math.max(from, offset), b = Math.min(to, offset + body.length);
            const mapped = Math.max(a, offset + body.length - suffix);
            if (a < Math.min(b, mapped)) { emit(into, { text: part.content.slice(a, Math.min(b, mapped)), start: 0, endCursor: false }); }
            if (mapped < b) {
                emit(into, { text: part.content.slice(mapped, b), path: part.location.path,
                    start: lineStart + original.length - body.length + mapped - offset, endCursor: b === offset + body.length });
            }
            const newline = offset + body.length;
            if (from <= newline && newline < to) {
                const end = lineStart + original.length;
                const start = source[end] === '\r' && source[end + 1] === '\n' ? end + 1 : end;
                if (!body.length && start !== end) { emit(into, { text: '', path: part.location.path, start: end, endCursor: true }); }
                emit(into, { text: '\n', path: start < source.length ? part.location.path : undefined, start, endCursor: false });
            }

        }
    }
    function expand(name: string, depth: number): Piece[] {
        if (depth > 128) { throw new Error('Language projection depth limit exceeded'); }
        const result: Piece[] = [];
        for (const part of graph.fragments.get(name)!.parts) {
            let cursor = 0;
            for (const ref of graph.references(part)) {
                literal(part, cursor, ref.start, result);
                const child = expand(ref.name, depth + 1);
                let lastIndex = child.length - 1;
                while (lastIndex >= 0 && !child[lastIndex].text.length) { lastIndex--; }
                const last = child[lastIndex];
                if (last?.text.endsWith('\n')) { last.text = last.text.slice(0, -1); last.endCursor = true; }
                const indent = /[ \t]*$/.exec(ref.prefix)![0];
                for (const piece of child) {
                    emit(result, piece);
                    if (piece.text.endsWith('\n') && indent) { emit(result, { text: indent, start: 0, endCursor: false }); }
                }
                cursor = ref.end;
            }
            literal(part, cursor, part.content.length, result);
        }
        return result;
    }
    try {
        for (const fragment of graph.fragments.values()) {
            if (!fragment.header.output) { continue; }
            const pieces = expand(fragment.header.name, 0);
            const raw = pieces.map(piece => piece.text).join('');
            const removed = new Set(Array.from(raw.matchAll(/\\\x3c\x3c/g), match => match.index!));
            const file: LanguageProjection = { path: fragment.header.output, language: fragment.header.language, content: '', mappings: [] };
            let rawOffset = 0;
            const body: Piece[] = [];
            for (const piece of pieces) {
                let start = 0;
                for (let end = 0; end <= piece.text.length; end++) {
                    if (end !== piece.text.length && !removed.has(rawOffset + end)) { continue; }
                    const text = piece.text.slice(start, end);
                    if (text || (piece.text.length === 0 && piece.endCursor)) {
                        emit(body, { text, path: piece.path, start: piece.start + start,
                            endCursor: end === piece.text.length && piece.endCursor });
                    }
                    start = end + 1;
                }
                rawOffset += piece.text.length;
            }
            applyTemplate(file, body, graph.sourceTemplates.get(fragment.header.name) ?? '[CODE]');
            files.push(file);
        }
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    return { files: diagnostics.length ? [] : files, diagnostics };
    function applyTemplate(file: LanguageProjection, body: Piece[], template: string): void {
        let slots = 0, cursor = 0, slot: number;
        while ((slot = template.indexOf('[CODE]', cursor)) !== -1) { slots++; cursor = slot + 6; }
        const units = template.length - slots * 6 + slots * body.reduce((sum, piece) => sum + piece.text.length, 0);
        const count = slots * body.length + slots + 1;
        if (bytes + units * 2 > 8 * 1024 * 1024 || segments + count > segmentLimit) {
            throw new Error('Language projection expansion limit exceeded');
        }
        bytes += units * 2;
        segments += count;
        const content: string[] = [];
        let generated = 0, trailingCR = false;
        const append = (piece: Piece): void => {
            const skip = trailingCR && piece.text.startsWith('\n') ? 1 : 0;
            if (piece.text.length) { trailingCR = piece.text.endsWith('\r'); }
            const text = piece.text.slice(skip).replace(/\r\n|\r/g, '\n');
            content.push(text);
            if (piece.path && (!skip || text.length)) {
                file.mappings.push({ sourcePath: piece.path, sourceStart: piece.start + skip,
                    sourceEnd: piece.start + piece.text.length, generatedStart: generated,
                    generatedEnd: generated + text.length, endCursor: piece.endCursor });
            }
            generated += text.length;
        };
        const literal = (from: number, to: number): void => {
            append({ text: template.slice(from, to), start: 0, endCursor: false });
        };
        cursor = 0;
        while ((slot = template.indexOf('[CODE]', cursor)) !== -1) {
            literal(cursor, slot);
            for (const piece of body) { append(piece); }
            cursor = slot + 6;
        }
        literal(cursor, template.length);
        file.content = content.join('');
    }
}
export function mapSourcePosition(files: LanguageProjection[], sourcePath: string, offset: number): SourceProjectionPosition | undefined {
    if (!Number.isInteger(offset) || offset < 0) { return undefined; }
    const path = safeRelativePath(sourcePath);
    for (const file of files) {
        for (const mapping of file.mappings) {
            if (mapping.sourcePath === path && offset >= mapping.sourceStart
                && (offset < mapping.sourceEnd || (offset === mapping.sourceEnd && mapping.endCursor))) {
                return { file, offset: mapping.generatedStart + offset - mapping.sourceStart, mapping };
            }
        }
    }
    return undefined;
}

export function mapGeneratedRange(file: LanguageProjection, start: number, end: number, mapping: ProjectionMapping): { start: number; end: number } | undefined {
    if (!file.mappings.includes(mapping) || !Number.isInteger(start) || !Number.isInteger(end)
        || start > end || start < mapping.generatedStart || end > mapping.generatedEnd
        || (start === end && start === mapping.generatedEnd && !mapping.endCursor)) { return undefined; }
    return { start: mapping.sourceStart + start - mapping.generatedStart, end: mapping.sourceStart + end - mapping.generatedStart };
}
