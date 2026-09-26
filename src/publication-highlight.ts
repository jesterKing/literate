import hljs from 'highlight.js';
import type { PublicationContribution } from './engine';
import type { LiterateTheme } from './themes';

export interface SyntaxSpan { start: number; end: number; scope: string; }
export interface HighlightedContribution {
    text: string;
    spans: SyntaxSpan[];
    references: { start: number; end: number; name: string; target: string }[];
}
function displayContribution(part: PublicationContribution): HighlightedContribution {
    const chunks: string[] = [];
    const references: HighlightedContribution['references'] = [];
    let rawOffset = 0, offset = 0;
    for (const segment of part.segments) {
        let text = segment.text;
        if (segment.kind === 'text') {
            text = text.replace(/\\\x3c\x3c/g, () => '<' + '<');
        } else {
            if (segment.modifier !== undefined) {
                throw new Error('Publication reference modifier is unsupported: ' + segment.name);
            }
            if (segment.resolution.kind !== 'resolved' || !segment.resolution.target) {
                throw new Error('Publication reference target is missing: ' + segment.name);
            }
            if (segment.start !== rawOffset || segment.end !== rawOffset + text.length) {
                throw new Error('Publication reference offsets do not match segment text');
            }
            references.push({ start: offset, end: offset + text.length,
                name: segment.name, target: segment.resolution.target });
        }
        chunks.push(text);
        offset += text.length;
        rawOffset += segment.text.length;
    }
    if (part.segments.map(segment => segment.text).join('') !== part.content) {
        throw new Error('Publication segments do not reconstruct contribution content');
    }
    return { text: chunks.join(''), spans: [], references };
}
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
function emitterRoot(text: string, language: string): unknown {
    if (hljs.versionString !== '11.9.0') {
        throw new Error('Publication highlighting requires highlight.js 11.9.0');
    }
    const result: unknown = hljs.highlight(text, { language, ignoreIllegals: true });
    if (!record(result) || !record(result._emitter) ||
        !record(result._emitter.rootNode)) {
        throw new Error('Unsupported highlight.js emitter shape');
    }
    return result._emitter.rootNode;
}
function syntaxSpans(text: string, root: unknown): SyntaxSpan[] {
    const spans: SyntaxSpan[] = [];
    const chunks: string[] = [];
    const stack = [{ node: root, scope: '' }];
    const seen = new Set<object>();
    let offset = 0;
    while (stack.length) {
        const { node, scope } = stack.pop()!;
        if (typeof node === 'string') {
            if (node.length) {
                spans.push({ start: offset, end: offset + node.length, scope });
                chunks.push(node);
                offset += node.length;
            }
            continue;
        }
        if (!record(node) || !Array.isArray(node.children) ||
            (node.scope !== undefined && typeof node.scope !== 'string') || seen.has(node)) {
            throw new Error('Unsupported highlight.js emitter tree');
        }
        seen.add(node);
        const inherited = typeof node.scope === 'string' && node.scope &&
            !node.scope.startsWith('language:') ? node.scope : scope;
        for (let index = node.children.length - 1; index >= 0; index--) {
            stack.push({ node: node.children[index], scope: inherited });
        }
    }
    if (chunks.join('') !== text) {
        throw new Error('highlight.js emitter did not reconstruct publication text');
    }
    return spans;
}
export function highlightContribution(part: PublicationContribution): HighlightedContribution {
    const display = displayContribution(part);
    display.spans = part.language && hljs.getLanguage(part.language)
        ? syntaxSpans(display.text, emitterRoot(display.text, part.language))
        : display.text.length ? [{ start: 0, end: display.text.length, scope: '' }] : [];
    return display;
}
/* eslint-disable @typescript-eslint/naming-convention -- highlight.js scope names are an external contract. */
const scopeColors: Readonly<Record<string, keyof LiterateTheme['colors']>> = {
    keyword: 'purple', 'selector-tag': 'purple', literal: 'purple',
    string: 'accent', regexp: 'accent', addition: 'accent',
    number: 'warning', symbol: 'warning', bullet: 'warning',
    title: 'information', section: 'information', built_in: 'information',
    type: 'information', link: 'information',
    attr: 'cyan', attribute: 'cyan', variable: 'cyan', 'template-variable': 'cyan',
    comment: 'muted', quote: 'muted', meta: 'yellow', doctag: 'yellow',
    deletion: 'danger', name: 'danger'
};
/* eslint-enable @typescript-eslint/naming-convention */
export function syntaxStyle(scope: string, theme: LiterateTheme): {
    color: string; bold: boolean; italic: boolean;
} {
    const base = scope.split('.')[0];
    const key = Object.prototype.hasOwnProperty.call(scopeColors, base) ? scopeColors[base] : 'text';
    return { color: theme.colors[key],
        bold: ['keyword', 'variable', 'template-variable', 'strong'].includes(base),
        italic: ['comment', 'quote', 'emphasis'].includes(base) };
}
