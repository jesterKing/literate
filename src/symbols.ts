import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import StateInline = require('markdown-it/lib/rules_inline/state_inline');
import StateBlock = require('markdown-it/lib/rules_block/state_block');
import { SourceDocument, FragmentTag, parseFragmentHeader, safeRelativePath, scanFragmentTags } from './engine';

export type FragmentOccurrence = {
    name: string; path: string; line: number; column: number; endColumn: number;
    kind: 'definition' | 'append' | 'reference' | 'mention';
};
export type FragmentRenameEdit = {
    path: string; line: number; startColumn: number; endColumn: number; newText: string;
};
type InlineTag = FragmentTag;
function normalizeDocuments(documents: SourceDocument[]): SourceDocument[] {
    const paths = new Set<string>();
    return documents.map(document => {
        const path = safeRelativePath(document.path);
        if (!path) { throw new Error(`Invalid source path: ${document.path}`); }
        const key = path.toLowerCase();
        if (paths.has(key)) { throw new Error(`Duplicate source document: ${path}`); }
        if (document.text.includes('\0')) { throw new Error(`NUL source text: ${path}`); }
        paths.add(key);
        return { path, text: document.text };
    });
}
function occurrence(tag: FragmentTag, path: string, line: number, offset: number,
    kind: FragmentOccurrence['kind']): FragmentOccurrence {
    return { name: tag.name, path, line, column: offset + tag.start,
        endColumn: offset + tag.end, kind };
}
function fenceOccurrences(token: Token, path: string, lines: string[]): FragmentOccurrence[] {
    const header = parseFragmentHeader(token.info);
    if (!header || !token.map) { return []; }
    const line = token.map[0];
    const infoStart = lines[line].indexOf(token.markup) + token.markup.length;
    const tag = { name: header.name, start: header.tagStart, end: header.tagEnd };
    const result = [occurrence(tag, path, line, infoStart, header.append ? 'append' : 'definition')];
    token.content.split('\n').forEach((body, index) => {
        const sourceLine = line + 1 + index;
        const offset = (lines[sourceLine] || '').length - body.length;
        for (const reference of scanFragmentTags(body)) {
            result.push(occurrence(reference, path, sourceLine, offset, 'reference'));
        }
    });
    return result;
}
function mentionParser(tags: InlineTag[], source: string): MarkdownIt {
    const md = new MarkdownIt();
    md.inline.ruler.before('text', 'fragment_mentions', (state, silent) => {
        if (!state.src.startsWith('<<', state.pos) || state.src[state.pos - 1] === '\\') { return false; }
        const tag = scanFragmentTags(state.src.slice(state.pos, state.posMax))[0];
        if (!tag || tag.start !== 0) { return false; }
        if (!silent) {
            if (state.src === source) { tags.push({ ...tag, start: state.pos, end: state.pos + tag.end }); }
            state.pending += state.src.slice(state.pos, state.pos + tag.end);
        }
        state.pos += tag.end;
        return true;
    });
    installCodeMentions(md, tags, source);
    return md;
}
function installCodeMentions(md: MarkdownIt, tags: InlineTag[], source: string): void {
    const backticks: (state: StateInline, silent: boolean) => boolean =
        require('markdown-it/lib/rules_inline/backticks');
    md.inline.ruler.at('backticks', (state, silent) => {
        const start = state.pos, count = state.tokens.length;
        const accepted = backticks(state, silent);
        if (accepted && !silent && state.src === source && state.tokens.length > count &&
            state.tokens[state.tokens.length - 1].type === 'code_inline') {
            for (const tag of scanFragmentTags(state.src.slice(start, state.pos))) {
                tags.push({ ...tag, start: start + tag.start, end: start + tag.end });
            }
        }
        return accepted;
    });
}
function proseOccurrences(token: Token, path: string, lines: string[]): FragmentOccurrence[] {
    if (!token.map) { return []; }
    const tags: InlineTag[] = [];
    const md = mentionParser(tags, token.content);
    md.inline.parse(token.content, md, {}, []);
    const contentLines = token.content.split('\n');
    return tags.flatMap(tag => {
        const before = token.content.slice(0, tag.start);
        const index = before.split('\n').length - 1;
        const line = token.map![0] + index, content = contentLines[index];
        const column = lines[line].indexOf(content.trim());
        if (column < 0) { return []; }
        const prefix = content.length - content.trimStart().length;
        const lineStart = before.lastIndexOf('\n') + 1;
        return [occurrence(tag, path, line, column - prefix - lineStart, 'mention')];
    });
}
type TableCell = { content: string; columns: number[] };
type TableSource = TableCell & { line: number };
function tableCells(raw: string, offset: number): TableCell[] {
    const cells: TableCell[] = [];
    let cell: TableCell = { content: '', columns: [] };
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (char === '|' && raw[index - 1] !== '\\') {
            cells.push(cell);
            cell = { content: '', columns: [] };
            continue;
        }
        if (char === '|') {
            cell.content = cell.content.slice(0, -1);
            cell.columns.pop();
        }
        cell.content += char;
        cell.columns.push(offset + index);
    }
    cells.push(cell);
    if (cells[0]?.content === '') { cells.shift(); }
    if (cells[cells.length - 1]?.content === '') { cells.pop(); }
    return cells.map(({ content, columns }) => {
        const start = content.length - content.trimStart().length;
        return { content: content.trim(), columns: columns.slice(start, content.trimEnd().length) };
    });
}
function tableParser(sources: WeakMap<Token, TableSource>): MarkdownIt {
    const md = new MarkdownIt();
    const table: (state: StateBlock, start: number, end: number, silent: boolean) => boolean =
        require('markdown-it/lib/rules_block/table');
    md.block.ruler.at('table', (state, start, end, silent) => {
        const count = state.tokens.length;
        const accepted = table(state, start, end, silent);
        if (!accepted || silent) { return accepted; }
        let line = start, cells: TableCell[] = [], index = 0;
        for (const token of state.tokens.slice(count)) {
            if (token.type === 'tr_open' && token.map) {
                line = token.map[0];
                const begin = state.bMarks[line] + state.tShift[line];
                const raw = state.src.slice(begin, state.eMarks[line]);
                const lineStart = state.src.lastIndexOf('\n', state.eMarks[line] - 1) + 1;
                const offset = begin - lineStart + raw.length - raw.trimStart().length;
                cells = tableCells(raw.trim(), offset);
                index = 0;
            } else if (token.type === 'inline') {
                const cell = cells[index++];
                if (cell && cell.content === token.content) { sources.set(token, { ...cell, line }); }
            }
        }
        return accepted;
    }, { alt: ['paragraph', 'reference'] });
    return md;
}
function tableOccurrences(token: Token, source: TableSource, path: string,
    lines: string[]): FragmentOccurrence[] {
    const tags: InlineTag[] = [];
    const md = mentionParser(tags, token.content);
    md.inline.parse(token.content, md, {}, []);
    return tags.flatMap(tag => {
        const column = source.columns[tag.start], endColumn = source.columns[tag.end - 1] + 1;
        const raw = lines[source.line].slice(column, endColumn);
        const original = scanFragmentTags(raw)[0];
        if (!original || original.start !== 0 || original.end !== raw.length) { return []; }
        return [occurrence(original, path, source.line, column, 'mention')];
    });
}
function documentOccurrences(document: SourceDocument): FragmentOccurrence[] {
    const lines = document.text.split(/\r\n|\r|\n/);
    const tables = new WeakMap<Token, TableSource>();
    const tokens = tableParser(tables).parse(document.text, {});
    const html = new MarkdownIt({ html: true }).parse(document.text, {})
        .filter(token => token.type === 'html_block' && token.map).map(token => token.map!);
    const result: FragmentOccurrence[] = [];
    for (const token of tokens) {
        if (token.type === 'fence') { result.push(...fenceOccurrences(token, document.path, lines)); }
        if (token.type === 'inline') {
            const source = tables.get(token);
            const mentions = source ? tableOccurrences(token, source, document.path, lines) :
                proseOccurrences(token, document.path, lines);
            result.push(...mentions.filter(item => !html.some(([start, end]) => item.line >= start && item.line < end)));
        }
    }
    return result.sort((a, b) => a.line - b.line || a.column - b.column);
}
export function collectFragmentOccurrences(documents: SourceDocument[]): FragmentOccurrence[] {
    return normalizeDocuments(documents).flatMap(documentOccurrences);
}
function validateRenameName(name: string, label: string): void {
    const stem = name.endsWith('.*') ? name.slice(0, -2) : name;
    if (!stem.trim() || name !== name.trim() || /[<>\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(name)) {
        throw new Error(`Invalid ${label} fragment name: expected a nonempty trimmed name without chevrons or controls`);
    }
}
function previewRename(documents: SourceDocument[], edits: FragmentRenameEdit[]): SourceDocument[] {
    return documents.map(document => {
        const parts = document.text.split(/(\r\n|\r|\n)/);
        const descending = edits.filter(edit => edit.path === document.path)
            .sort((a, b) => b.line - a.line || b.startColumn - a.startColumn);
        for (const edit of descending) {
            const index = edit.line * 2, line = parts[index];
            parts[index] = line.slice(0, edit.startColumn) + edit.newText + line.slice(edit.endColumn);
        }
        return { path: document.path, text: parts.join('') };
    });
}
function validateRenameSyntax(documents: SourceDocument[], edits: FragmentRenameEdit[],
    occurrences: FragmentOccurrence[], oldName: string, newName: string): void {
    const actual = collectFragmentOccurrences(previewRename(documents, edits));
    const unchanged = actual.length === occurrences.length && occurrences.every((before, index) => {
        const after = actual[index];
        return after.path === before.path && after.line === before.line && after.kind === before.kind &&
            after.name === (before.name === oldName ? newName : before.name);
    });
    if (!unchanged) {
        throw new Error('Unsafe fragment rename: Markdown syntax changes the fragment occurrence sequence');
    }
}
export function planFragmentRename(documents: SourceDocument[], oldName: string, newName: string): FragmentRenameEdit[] {
    validateRenameName(oldName, 'old');
    validateRenameName(newName, 'new');
    if (oldName.endsWith('.*') !== newName.endsWith('.*')) {
        throw new Error('Fragment rename must preserve the root suffix .*');
    }
    const normalized = normalizeDocuments(documents);
    const occurrences = collectFragmentOccurrences(normalized);
    const definitions = occurrences.filter(item => item.name === oldName && item.kind === 'definition');
    if (definitions.length !== 1) {
        throw new Error(`Expected exactly one base definition for ${oldName}; found ${definitions.length}`);
    }
    if (oldName === newName) { return []; }
    if (newName.includes('`')) {
        throw new Error('Invalid new fragment name: backticks are unsafe in fence headers and inline code');
    }
    if (occurrences.some(item => item.name === newName)) {
        throw new Error(`Fragment name collision: ${newName} already occurs in the project`);
    }
    const edits = occurrences.filter(item => item.name === oldName).map(item => ({
        path: item.path, line: item.line, startColumn: item.column + 2,
        endColumn: item.endColumn - 2, newText: newName
    }));
    validateRenameSyntax(normalized, edits, occurrences, oldName, newName);
    return edits;
}
