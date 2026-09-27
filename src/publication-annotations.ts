import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import type { GenerationDiagnostic as Diagnostic } from './engine';

type Location = { path: string; line: number; column: number };
export interface PublicationTerm {
    key: string; title: string; target: string; at: Location; tokenIndex: number; body: string;
}
export interface PublicationNote {
    target: string; number: number; at: Location; tokenIndex: number; body: string;
}
export interface PublicationTermUse {
    key: string; target?: string; at: Location; owner: string;
    tokenIndex: number; childIndex: number;
    resolution: 'resolved' | 'missing' | 'ambiguous';
}
export interface PublicationAnnotations {
    terms: PublicationTerm[]; notes: PublicationNote[];
    uses: PublicationTermUse[]; diagnostics: Diagnostic[];
}
export function parseAnnotationBody(body: string): Token[] {
    return new MarkdownIt({ html: true }).parse(body, {});
}
const allowedBodyTokens = new Set([
    'paragraph_open', 'paragraph_close', 'inline', 'text', 'softbreak', 'hardbreak',
    'bullet_list_open', 'bullet_list_close', 'ordered_list_open', 'ordered_list_close',
    'list_item_open', 'list_item_close', 'em_open', 'em_close', 'strong_open',
    'strong_close', 'code_inline', 'link_open', 'link_close'
]);
function invalidBodyToken(tokens: readonly Token[]): Token | undefined {
    for (const token of tokens) {
        if (!allowedBodyTokens.has(token.type)) { return token; }
        const invalid = invalidBodyToken(token.children || []);
        if (invalid) { return invalid; }
    }
    return undefined;
}
const keyPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
function encode(value: string): string {
    return value.split('').map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
}
function termKey(href: string): string | undefined {
    if (!href.startsWith('term:')) { return undefined; }
    try { return decodeURIComponent(href.slice(5)); } catch { return undefined; }
}
export function resolveTermHref(annotations: PublicationAnnotations, href: string): string | undefined {
    const key = termKey(href);
    if (key === undefined || !keyPattern.test(key)) { return undefined; }
    const terms = annotations.terms.filter(term => term.key === key);
    return terms.length === 1 ? terms[0].target : undefined;
}
export function termByTarget(annotations: PublicationAnnotations, target: string): PublicationTerm | undefined {
    return annotations.terms.find(term => term.target === target);
}
export function collectAnnotations(
    documents: readonly { path: string; text: string; tokens: readonly Token[] }[]
): PublicationAnnotations {
    const result: PublicationAnnotations = { terms: [], notes: [], uses: [], diagnostics: [] };
    const report = (at: Location, code: string, message: string): void => {
        result.diagnostics.push({ ...at, code, message });
    };
        const collectUses = (tokens: readonly Token[], owner: string,
            location: (token: Token) => Location, tokenOffset = 0): void => {
            tokens.forEach((token, tokenIndex) => {
                if (token.type !== 'inline') { return; }
                (token.children || []).forEach((child, childIndex) => {
                    const href = child.type === 'link_open' ? child.attrGet('href') : null;
                    if (!href?.startsWith('term:')) { return; }
                    result.uses.push({ key: termKey(href) ?? href.slice(5), at: location(token),
                        owner, tokenIndex: tokenIndex + tokenOffset, childIndex, resolution: 'missing' });
                });
            });
        };
        for (const document of documents) {
            const lines = document.text.split(/\r\n|\r|\n/);
            const location = (token: Token): Location => ({ path: document.path,
                line: token.map?.[0] ?? 0, column: token.type === 'fence'
                    ? Math.max(0, (lines[token.map?.[0] ?? 0] || '').indexOf(token.markup)) : 0 });
            document.tokens.forEach((token, tokenIndex) => {
                if (token.type === 'inline') {
                    // Preserve source encounter order with body uses between prose uses.
                    collectUses([token], document.path, location, tokenIndex);
                }
                if (token.type !== 'fence' || !/^(TERM|NOTE)(?:\s|$)/.test(token.info.trim())) { return; }
                const header = token.info.trim();
                const at = location(token);
                const body = token.content;
                let annotation: PublicationTerm | PublicationNote;
                            if (header === 'NOTE') {
                                annotation = { target: `annotation-note-${encode(document.path)}-${at.line}-${at.column}`,
                                    number: result.notes.length + 1, at, tokenIndex, body };
                                result.notes.push(annotation);
                            } else {
                                const match = /^TERM\s+([A-Za-z][A-Za-z0-9_.:-]{0,99})\s+("(?:[^"\\]|\\.)*")$/.exec(header);
                                let title: unknown;
                                try { title = match ? JSON.parse(match[2]) : undefined; } catch { title = undefined; }
                                if (!match || typeof title !== 'string' || [...title].length > 200) {
                                    report(at, 'annotation-header', 'Expected TERM key "title" (JSON string, at most 200 code points) or NOTE');
                                    return;
                                }
                                const base = `annotation-term-${encode(match[1])}`;
                                annotation = { key: match[1], title, target: `${base}-${encode(document.path)}-${at.line}-${at.column}`,
                                    at, tokenIndex, body };
                                result.terms.push(annotation);
                            }
                const bodyTokens = parseAnnotationBody(body);
                const invalid = invalidBodyToken(bodyTokens);
                if (invalid) { report(at, 'annotation-body', `Unsupported annotation body token: ${invalid.type}`); }
                collectUses(bodyTokens, annotation.target, () => at);
            });
        }
        const byKey = new Map<string, PublicationTerm[]>();
        for (const term of result.terms) { byKey.set(term.key, [...(byKey.get(term.key) || []), term]); }
        for (const term of result.terms) {
            if (byKey.get(term.key)!.length > 1) {
                report(term.at, 'annotation-duplicate', `Duplicate TERM key: ${term.key}`);
            } else {
                const target = `annotation-term-${encode(term.key)}`;
                for (const use of result.uses) { if (use.owner === term.target) { use.owner = target; } }
                term.target = target;
            }
        }
        for (const use of result.uses) {
            const terms = keyPattern.test(use.key) ? byKey.get(use.key) || [] : [];
            use.resolution = terms.length === 1 ? 'resolved' : terms.length > 1 ? 'ambiguous' : 'missing';
            if (use.resolution === 'resolved') { use.target = terms[0].target; }
            else { report(use.at, `annotation-${use.resolution}`, `${use.resolution} TERM use: ${use.key}`); }
        }
    return result;
}
