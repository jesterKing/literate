import type { ParsedProject, PublicationContribution, GenerationDiagnostic } from './engine';
import { preparePandoc } from './publication-pandoc';
import { resolvePublicationSettings } from './publication-settings';
import type { PublicationSettingsResult } from './publication-settings';
import type { PandocDocument, PandocBlock } from './publication-pandoc';
import { defaultThemeName, getTheme } from './themes';
import type { LiterateTheme } from './themes';
import { highlightContribution, syntaxStyle } from './publication-highlight';
export interface LatexOptions {
    theme?: string;
    paper?: 'A4' | 'A5' | 'letter' | 'legal';
    marginMm?: number;
    marginTopMm?: number;
    marginRightMm?: number;
    marginBottomMm?: number;
    marginLeftMm?: number;
    bodyFont?: string;
    headingFont?: string;
    codeFont?: string;
    fragmentFont?: string;
    noteFont?: string;
    codeLigatures?: boolean;
}
export interface LatexConversionOptions {
    standalone: false;
    syntaxHighlighting: 'none';
    topLevelDivision: 'chapter';
}
export type LatexConverter = (document: PandocDocument,
    options: LatexConversionOptions) => Promise<string>;
export interface LatexResult { latex?: string; diagnostics: GenerationDiagnostic[]; }
interface CheckedOptions {
    theme: LiterateTheme; paper: string; geometry: string;
    bodyFont: string; headingFont: string; codeFont: string;
    fragmentFont: string; noteFont: string; codeLigatures: boolean;
}
function fontName(value: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,99}$/.test(value)) {
        throw new Error('Font must be a simple family name (1–100 ASCII characters)');
    }
    return value;
}
function checkOptions(options: LatexOptions, settings: PublicationSettingsResult): CheckedOptions {
    const theme = getTheme(options.theme ?? defaultThemeName);
    if (!theme) { throw new Error('Unknown publication theme'); }
    const papers = new Map<string, [string, number, number]>([
        ['A4', ['a4paper', 210, 297]], ['A5', ['a5paper', 148, 210]],
        ['letter', ['letterpaper', 215.9, 279.4]], ['legal', ['legalpaper', 215.9, 355.6]]
    ]);
    const paper = papers.get(options.paper ?? 'A4');
    const margin = options.marginMm ?? 20;
    const overrides = [options.marginTopMm, options.marginRightMm,
        options.marginBottomMm, options.marginLeftMm];
    const [top, right, bottom, left] = overrides.map(value => value ?? margin);
    if (!paper || [margin, top, right, bottom, left].some(value =>
        !Number.isFinite(value) || value < 5 || value > 50) ||
        paper[1] - left - right < 80 || paper[2] - top - bottom < 100) {
        throw new Error('Invalid paper or margin; require 5–50 mm and an 80 × 100 mm body');
    }
    const geometry = overrides.some(value => value !== undefined)
        ? `top=${top}mm,right=${right}mm,bottom=${bottom}mm,left=${left}mm`
        : `margin=${margin}mm`;
    const codeLigatures = options.codeLigatures ?? settings.codeLigatures;
    if (typeof codeLigatures !== 'boolean') { throw new Error('Code ligatures must be boolean'); }
    return { theme, paper: paper[0], geometry, codeLigatures,
        bodyFont: fontName(options.bodyFont ?? settings.fonts.body),
        headingFont: fontName(options.headingFont ?? settings.fonts.heading),
        codeFont: fontName(options.codeFont ?? settings.fonts.code),
        fragmentFont: fontName(options.fragmentFont ?? settings.fonts.fragment),
        noteFont: fontName(options.noteFont ?? settings.fonts.note) };
}
function checkText(text: string): void {
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) {
        throw new Error('Unsupported control character in publication text');
    }
}
function tex(text: string): string {
    checkText(text);
    const escapes = new Map([
        ['\\', '\\textbackslash{}'], ['{', '\\{'], ['}', '\\}'], ['#', '\\#'],
        ['$', '\\$'], ['%', '\\%'], ['&', '\\&'], ['_', '\\_'],
        ['^', '\\textasciicircum{}'], ['~', '\\textasciitilde{}']
    ]);
    return text.replace(/[\\{}#$%&_^~]/g, character => escapes.get(character)!);
}
function target(value: string): string {
    let result = 'lit-';
    for (let index = 0; index < value.length; index++) {
        result += value.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return result;
}
function nameText(name: string): string {
    if (Array.from(name).length > 512 || /[\r\n\t]/.test(name)) {
        throw new Error('Fragment names must be single-line and at most 512 code points');
    }
    return Array.from(name, character => tex(character)).join('\\allowbreak{}');
}
function color(value: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) { throw new Error('Invalid syntax/theme colour'); }
    return value.slice(1);
}
function pageLink(id: string, label: string): string {
    const destination = target(id);
    return `\\hyperref[${destination}]{${label}\\textsuperscript{\\notefont\\pageref*{${destination}}}}`;
}
function anchor(id: string): string { return `\\phantomsection\\label{${target(id)}}`; }
function template(body: string, options: CheckedOptions, definitions: string[]): string {
    const c = options.theme.colors;
    return themeNotice() + String.raw`\documentclass[11pt,oneside,openany]{scrbook}
${'\\usepackage'}{fontspec}
\setmainfont{${options.bodyFont}}
\newfontfamily\headingfont{${options.headingFont}}
\newfontfamily\fragmentfont{${options.fragmentFont}}
\newfontfamily\notefont{${options.noteFont}}
\setmonofont[Ligatures=Common,Contextuals=Alternate,${options.codeLigatures ? '' : 'RawFeature={-calt},'}
ItalicFont={${options.codeFont}},ItalicFeatures={FakeSlant=0.2},
BoldItalicFont={${options.codeFont}},BoldItalicFeatures={FakeSlant=0.2,FakeBold=1.5}]{${options.codeFont}}
${'\\usepackage'}[${options.paper},${options.geometry}]{geometry}
${'\\usepackage'}{fvextra,needspace,xcolor,microtype,amssymb,amsmath}
${'\\usepackage'}[normalem]{ulem}
${'\\usepackage'}[hidelinks]{hyperref}
\definecolor{publicationBackground}{HTML}{${color(c.background)}}
\definecolor{publicationText}{HTML}{${color(c.text)}}
\definecolor{publicationAccent}{HTML}{${color(c.accent)}}
\pagecolor{publicationBackground}\color{publicationText}
\setkomafont{disposition}{\headingfont\bfseries\color{publicationAccent}}
\setkomafont{pageheadfoot}{\notefont\color{publicationText}}
\setkomafont{footnote}{\notefont}
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}
\providecommand{\passthrough}[1]{#1}
\providecommand{\pandocbounded}[1]{#1}
` + templateCodeSettings() + '\n' + definitions.join('\n') +
        '\n\\begin{document}\n\\tableofcontents\n' + body + '\n\\end{document}\n';
}
function templateCodeSettings(): string {
    return String.raw`\fvset{fontsize=\small,breaklines=true,breakanywhere=true,
breakautoindent=false,breaksymbolleft={},breaksymbolright={},
breakanywheresymbolpre={},breakanywheresymbolpost={},frame=none}
\providecommand{\st}[1]{\sout{#1}}
\DefineVerbatimEnvironment{Highlighting}{Verbatim}{}
\RecustomVerbatimEnvironment{verbatim}{Verbatim}{}
\newcommand{\LitStyle}[4]{{\color[HTML]{#1}#2#3\FancyVerbBreakStart#4\FancyVerbBreakStop}}
\setlength{\parindent}{0pt}
\setlength{\parskip}{5pt}
\pagestyle{headings}`;
}
function themeNotice(): string {
    return [
        'Theme palette snapshot: HErmonica drawing defaults (hermonica),',
        'and NvChad/base46 v2.5 themes; see THIRD_PARTY_NOTICES.md.',
        'nvim-base16.lua is a library for modifying themes with Lua',
        'Copyright © 2019 Ashkan Kiani',
        '',
        'Permission is hereby granted, free of charge, to any person obtaining',
        'a copy of this software and associated documentation files (the "Software"),',
        'to deal in the Software without restriction, including without limitation',
        'the rights to use, copy, modify, merge, publish, distribute, sublicense,',
        'and/or sell copies of the Software, and to permit persons to whom the',
        'Software is furnished to do so, subject to the following conditions:',
        'The above copyright notice and this permission notice shall be included',
        'in all copies or substantial portions of the Software.',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
        'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES',
        'OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
        'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,',
        'DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,',
        'TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE',
        'OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'
    ].map(line => '% ' + line).join('\n') + '\n';
}
type Highlighted = ReturnType<typeof highlightContribution>;
function verbatimText(text: string): string {
    checkText(text);
    return text.replace(/[\\{}]/g, character => {
        if (character === '\\') { return '\\textbackslash{}'; }
        return character === '{' ? '\\textbraceleft{}' : '\\textbraceright{}';
    });
}
function styled(text: string, scope: string, theme: LiterateTheme): string {
    const style = syntaxStyle(scope, theme);
    return text.split('\n').map(line => line.length ?
        `\\LitStyle{${color(style.color)}}{${style.bold ? '\\bfseries' : ''}}` +
        `{${style.italic ? '\\itshape' : ''}}{${verbatimText(line)}}` : '').join('\n');
}
function literal(data: Highlighted, start: number, end: number, theme: LiterateTheme): string {
    if (start === end) { return ''; }
    let cursor = start;
    let result = '';
    for (const span of data.spans) {
        const left = Math.max(start, span.start), right = Math.min(end, span.end);
        if (left >= right) { continue; }
        result += verbatimText(data.text.slice(cursor, left));
        result += styled(data.text.slice(left, right), span.scope, theme);
        cursor = right;
    }
    result += verbatimText(data.text.slice(cursor, end));
    return '\\begin{Verbatim}[commandchars=\\\\\\{\\}]\n' + result +
        (result.endsWith('\n') ? '' : '\n') + '\\end{Verbatim}\n';
}
function validateHighlight(data: Highlighted): void {
    checkText(data.text);
    for (const ranges of [data.spans, data.references]) {
        let end = 0;
        for (const range of ranges) {
            if (!Number.isInteger(range.start) || !Number.isInteger(range.end) ||
                range.start < end || range.end <= range.start || range.end > data.text.length) {
                throw new Error('Invalid highlighting ranges');
            }
            end = range.end;
        }
    }
}
function macroName(index: number): string {
    let suffix = '';
    do { suffix = String.fromCharCode(65 + index % 26) + suffix;
        index = Math.floor(index / 26) - 1;
    } while (index >= 0);
    return `LitReference${suffix}`;
}
function mergeStyles(data: Highlighted, theme: LiterateTheme): void {
    const merged: Highlighted['spans'] = [];
    let previousStyle = '';
    for (const span of data.spans) {
        const style = JSON.stringify(syntaxStyle(span.scope, theme));
        const previous = merged[merged.length - 1];
        if (previous && previous.end === span.start && style === previousStyle) {
            previous.end = span.end;
        } else { merged.push({ ...span }); }
        previousStyle = style;
    }
    data.spans = merged;
}
function ordinaryCode(blocks: PandocBlock[], theme: LiterateTheme): PandocBlock[] {
    return blocks.map(block => {
        switch (block.t) {
            case 'CodeBlock': {
                const text = block.c[1];
                const data: Highlighted = { text, references: [],
                    spans: text ? [{ start: 0, end: text.length, scope: '' }] : [] };
                return { t: 'RawBlock', c: ['latex', literal(data, 0, text.length, theme)] };
            }
            case 'Div': return { ...block, c: [block.c[0], ordinaryCode(block.c[1], theme)] };
            case 'BlockQuote': return { ...block, c: ordinaryCode(block.c, theme) };
            case 'BulletList': return { ...block, c: block.c.map(item => ordinaryCode(item, theme)) };
            case 'OrderedList': return { ...block,
                c: [block.c[0], block.c[1].map(item => ordinaryCode(item, theme))] };
            default: return block;
        }
    });
}
function contribution(part: PublicationContribution, project: ParsedProject,
    theme: LiterateTheme, definitions: string[]): PandocBlock[] {
    const family = project.publication.fragments.find(item => item.target === part.fragmentTarget);
    if (!family) { throw new Error('Contribution has no fragment family'); }
    const position = family.contributions.indexOf(part.target);
    if (position < 0) { throw new Error('Contribution is absent from its family'); }
    const data = highlightContribution(part);
    validateHighlight(data);
    mergeStyles(data, theme);
    let output = '\\par\\Needspace{5\\baselineskip}\n' + anchor(part.target);
    if (part.kind === 'definition') { output += anchor(family.target); }
    output += `{\\fragmentfont\\raggedright\\color{publicationAccent} ${nameText(family.name)}` +
        `\\enspace\\ensuremath{${part.kind === 'definition' ? '\\equiv' : '+\\equiv'}}\\par}\n`;
    const navigation: string[] = [];
    if (position > 0) { navigation.push(pageLink(family.contributions[position - 1], 'Previous ')); }
    if (part.kind === 'append') { navigation.push(pageLink(family.target, 'Base ')); }
    if (position + 1 < family.contributions.length) {
        navigation.push(pageLink(family.contributions[position + 1], 'Next '));
    }
    if (navigation.length) { output += `{\\notefont\\small ${navigation.join('\\quad ')}\\par}\n`; }
    output += contributionBody(data, project, theme, definitions);
    return [{ t: 'RawBlock', c: ['latex', output] }];
}
function contributionBody(data: Highlighted, project: ParsedProject,
    theme: LiterateTheme, definitions: string[]): string {
    let cursor = 0, output = '';
    for (const reference of data.references) {
        if (!project.publication.fragments.some(family =>
            family.target === reference.target && family.name === reference.name)) {
            throw new Error('Unknown highlighted reference destination');
        }
        output += literal(data, cursor, referencePrefixEnd(data.text, cursor, reference.start), theme);
        const command = macroName(definitions.length);
        const label = '\\textless{}\\textless{}' + nameText(reference.name) +
            '\\textgreater{}\\textgreater{}';
        definitions.push(`\\newcommand{\\${command}}{\\par\\begingroup` +
            '\\leftskip=1.5em\\rightskip=0pt plus 1fil\\parindent=0pt' +
            '\\fragmentfont\\small\\noindent ' + pageLink(reference.target, label) +
            '\\par\\endgroup}');
        output += `\\${command}{}\n`;
        cursor = reference.end + (data.text[reference.end] === '\n' ? 1 : 0);
    }
    return output + literal(data, cursor, data.text.length, theme);
}
function referencePrefixEnd(text: string, cursor: number, start: number): number {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    return /^[ \t]*$/.test(text.slice(lineStart, start)) ? Math.max(cursor, lineStart) : start;
}
export async function renderLatex(parsed: ParsedProject, options: LatexOptions,
    convert: LatexConverter): Promise<LatexResult> {
    let stage = 'latex-options';
    try {
        const settings = resolvePublicationSettings(parsed);
        if (settings.diagnostics.length) {
            return { diagnostics: [...parsed.diagnostics, ...settings.diagnostics] };
        }
        const checked = checkOptions(options, settings);
        const definitions: string[] = [];
        stage = 'latex-preparation';
        const prepared = preparePandoc(parsed, part =>
            contribution(part, parsed, checked.theme, definitions));
        if (!prepared.document) { return { diagnostics: prepared.diagnostics }; }
        prepared.document.blocks = ordinaryCode(prepared.document.blocks, checked.theme);
        stage = 'latex-conversion';
        const body = await convert(prepared.document, {
            standalone: false, syntaxHighlighting: 'none', topLevelDivision: 'chapter'
        });
        if (typeof body !== 'string') { throw new Error('Converter must return a LaTeX body string'); }
        stage = 'latex-template';
        return { latex: template(body, checked, definitions), diagnostics: [] };
    } catch (error) {
        return { diagnostics: [{ path: parsed.documents[0]?.path ?? '', line: 0, column: 0,
            code: stage, message: error instanceof Error ? error.message : String(error) }] };
    }
}
