import type { ParsedProject, PublicationContribution, GenerationDiagnostic } from './engine';
import { preparePandoc, PandocInline } from './publication-pandoc';
import type { PublicationLinkResolver } from './publication-pandoc';
import { publicationRail, RailFragment, RailNote, RailTerm } from './publication-rail';
import { resolvePublicationSettings } from './publication-settings';
import { checkFontFace, fontFaces, fontFile, PortableFont } from './publication-fonts';
import type { PublicationSettingsResult } from './publication-settings';
import type { PandocDocument, PandocBlock, PublicationAsset } from './publication-pandoc';
import { defaultThemeName, getTheme } from './themes';
import type { LiterateTheme } from './themes';
import { highlightContribution, syntaxStyle } from './publication-highlight';
export const publicationTemplateVersion = 5;
export interface LatexOptions {
    assetPath?: (asset: PublicationAsset) => string;
    publicationLink?: PublicationLinkResolver;
    theme?: string;
    paper?: 'A4' | 'A5' | 'letter' | 'legal';
    marginMm?: number;
    marginTopMm?: number;
    marginRightMm?: number;
    marginBottomMm?: number;
    marginLeftMm?: number;
    marginInnerMm?: number;
    marginOuterMm?: number;
    bodyFont?: string;
    headingFont?: string;
    codeFont?: string;
    fragmentFont?: string;
    noteFont?: string;
    codeLigatures?: boolean;
    portableFonts?: Record<string, PortableFont>;
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
    theme: LiterateTheme; paper: string; geometry: string; sides: 'oneside' | 'twoside';
    bodyFont: string; headingFont: string; codeFont: string;
    fragmentFont: string; noteFont: string; codeLigatures: boolean;
    bodyFontSize: number; codeFontSize: number; railFontSize: number;
    portableFonts?: Record<string, PortableFont>;
}
function fontName(value: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,99}$/.test(value)) {
        throw new Error('Font must be a simple family name (1–100 ASCII characters)');
    }
    return value;
}
function checkOptions(options: LatexOptions, settings: PublicationSettingsResult, rail = false): CheckedOptions {
    const theme = getTheme(options.theme ?? defaultThemeName);
    if (!theme) { throw new Error('Unknown publication theme'); }
    const papers = new Map<string, [string, number, number]>([
        ['A4', ['a4paper', 210, 297]], ['A5', ['a5paper', 148, 210]],
        ['letter', ['letterpaper', 215.9, 279.4]], ['legal', ['legalpaper', 215.9, 355.6]]
    ]);
    const paper = papers.get(options.paper ?? 'A4');
    const margin = options.marginMm ?? 20;
    const physical = [options.marginRightMm, options.marginLeftMm];
    const mirrored = [options.marginOuterMm, options.marginInnerMm];
    const twoSided = mirrored.some(value => value !== undefined);
    if (twoSided && physical.some(value => value !== undefined)) {
        throw new Error('Cannot mix left/right margins with inner/outer margins');
    }
    const top = options.marginTopMm ?? margin, bottom = options.marginBottomMm ?? margin;
    const first = (twoSided ? options.marginOuterMm : options.marginRightMm) ?? margin;
    const second = (twoSided ? options.marginInnerMm : options.marginLeftMm) ?? margin;
    if (!paper || [margin, top, bottom, first, second].some(value =>
        !Number.isFinite(value) || value < 5 || value > 50) ||
        paper[1] - first - second - (rail ? 30 : 0) < 80 || paper[2] - top - bottom < 100) {
        throw new Error('Invalid paper or margin; require 5–50 mm and an 80 × 100 mm body');
    }
    const sides = twoSided ? 'twoside' : 'oneside';
    const geometry = twoSided
        ? `top=${top}mm,outer=${first + (rail ? 30 : 0)}mm,bottom=${bottom}mm,inner=${second}mm`
        : rail || physical.some(value => value !== undefined)
            || options.marginTopMm !== undefined || options.marginBottomMm !== undefined
            ? `top=${top}mm,right=${first + (rail ? 30 : 0)}mm,bottom=${bottom}mm,left=${second}mm`
            : `margin=${margin}mm`;
    const codeLigatures = options.codeLigatures ?? settings.codeLigatures;
    if (typeof codeLigatures !== 'boolean') { throw new Error('Code ligatures must be boolean'); }
    return { theme, paper: paper[0], geometry, sides, codeLigatures, portableFonts: options.portableFonts,
        bodyFontSize: settings.fontSizes.body, codeFontSize: settings.fontSizes.code,
        railFontSize: settings.fontSizes.rail,
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
function fontCommand(command: string, family: string, options: CheckedOptions, code = false): string {
    const features = code ? `Ligatures=Common,Contextuals=Alternate,${options.codeLigatures ? '' : 'RawFeature={-calt},'}` : '';
    if (options.portableFonts !== undefined) {
        const font = Object.prototype.hasOwnProperty.call(options.portableFonts, family)
            ? options.portableFonts[family] : undefined;
        if (!font) { throw new Error(`Invalid or missing portable font companions for ${family}`); }
        return portableFontCommand(command, family, font, features);
    }
    if (!code) { return `${command}{${family}}`; }
    if (family !== 'D2CodingLigature Nerd Font Propo') {
        return `${command}[${features.slice(0, -1)}]{${family}}`;
    }
    return `${command}[${features}\nItalicFont={${family}},ItalicFeatures={FakeSlant=0.2},\nBoldItalicFont={${family}},BoldItalicFeatures={FakeSlant=0.2,FakeBold=1.5}]{${family}}`;
}
function companionPath(value: unknown, where: string): string {
    if (typeof value !== 'string' ||
        !/^lit-fonts-[a-f0-9]{64}\/[a-f0-9]{64}\.(ttf|otf)$/.test(value)) {
        throw new Error(`Invalid or missing portable font companions for ${where}`);
    }
    return value;
}
function portableFontCommand(command: string, family: string, font: PortableFont, features: string): string {
    const checked = {} as PortableFont;
    for (const face of fontFaces) {
        checked[face] = checkFontFace(font[face], face, `${family}.${face}`, companionPath);
    }
    const regular = fontFile(checked.regular);
    const directory = regular.slice(0, regular.lastIndexOf('/') + 1);
    if (fontFaces.some(face => !fontFile(checked[face]).startsWith(directory))) {
        throw new Error(`Portable font faces must share one companion directory for ${family}`);
    }
    const name = (face: keyof PortableFont): string => fontFile(checked[face]).slice(directory.length);
    return `${command}[${features}Path={${directory}},BoldFont={${name('bold')}},` +
        `ItalicFont={${name('italic')}},BoldItalicFont={${name('boldItalic')}}` +
        `${slantFeatures(checked)}]{${name('regular')}}`;
}
function slantFeatures(font: PortableFont): string {
    let features = '';
    for (const [face, option] of [['italic', 'ItalicFeatures'], ['boldItalic', 'BoldItalicFeatures']] as const) {
        const choice = font[face];
        if (typeof choice !== 'string') { features += `,${option}={FakeSlant=${choice.slant}}`; }
    }
    return features;
}
function template(body: string, options: CheckedOptions, definitions: string[], rail: string): string {
    const c = options.theme.colors;
    return `% Literate publication template v${publicationTemplateVersion}\n` + themeNotice() + String.raw`\newcommand{\DoNotLoadEpstopdf}{}
    \documentclass[fontsize=${decimal(options.bodyFontSize)}pt,${options.sides},openany]{scrbook}
${'\\usepackage'}{fontspec}
${fontCommand('\\setmainfont', options.bodyFont, options)}
${fontCommand('\\newfontfamily\\headingfont', options.headingFont, options)}
${fontCommand('\\newfontfamily\\fragmentfont', options.fragmentFont, options)}
${fontCommand('\\newfontfamily\\notefont', options.noteFont, options)}
${fontCommand('\\setmonofont', options.codeFont, options, true)}
${'\\usepackage'}[${options.paper},${options.geometry}]{geometry}
${'\\usepackage'}{fvextra,needspace,xcolor,microtype,amssymb,amsmath,graphicx}
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
` + templateCodeSettings(options) + '\n' + templateImageSettings() + '\n' + definitions.join('\n') + (rail ? '\n' + rail : '') +
        '\n\\begin{document}\n\\tableofcontents\n' + body + '\n\\end{document}\n';
}
function decimal(value: number): string {
    return String(Number(value.toFixed(2)));
}
function templateCodeSettings(options: CheckedOptions): string {
    const size = decimal(options.codeFontSize);
    const leading = decimal(options.codeFontSize * 1.2);
    return String.raw`\newcommand{\LitCodeSize}{\fontsize{${size}pt}{${leading}pt}\selectfont}
\fvset{fontsize=\LitCodeSize,breaklines=true,breakanywhere=true,
breakautoindent=false,breaksymbolleft={},breaksymbolright={},
breakanywheresymbolpre={},breakanywheresymbolpost={},frame=none}
\DeclareRobustCommand{\LitInlineCode}[1]{\texttt{#1}}

\setlength{\emergencystretch}{3em}
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
function templateImageSettings(): string {
    return String.raw`\newsavebox{\LitCaptionBox}
\newsavebox{\LitDiagramBox}
\newlength{\LitImageHeight}
\newlength{\LitDiagramHeight}
\newcommand{\LitImage}[2]{\par\penalty0\addvspace{6pt}%
\begingroup
\sbox{\LitCaptionBox}{\parbox{\linewidth}{\small\raggedright #2\par}}%
\setlength{\LitImageHeight}{\dimexpr\textheight-\ht\LitCaptionBox-\dp\LitCaptionBox-24pt\relax}%
\ifdim\LitImageHeight<24pt
  \PackageError{literate}{Image caption leaves no space for graphic}{Shorten the caption.}%
\else
  \noindent\vbox{\hbox to\linewidth{\hfil
    \includegraphics[width=\linewidth,height=\LitImageHeight,keepaspectratio]{#1}\hfil}%
    \kern6pt\nointerlineskip\hbox{${'\\usebox'}{\LitCaptionBox}}\kern0pt}%
\fi
\par\endgroup\addvspace{6pt}}
\newcommand{\LitDiagram}[1]{\par\penalty0\addvspace{6pt}%
\begingroup
\setlength{\LitDiagramHeight}{\dimexpr\textheight-12pt\relax}%
\sbox{\LitDiagramBox}{\includegraphics{#1}}%
\ifdim\wd\LitDiagramBox>\linewidth
  \sbox{\LitDiagramBox}{\includegraphics[width=\linewidth]{#1}}%
\fi
\ifdim\dimexpr\ht\LitDiagramBox+\dp\LitDiagramBox\relax>\LitDiagramHeight
  \sbox{\LitDiagramBox}{\includegraphics[height=\LitDiagramHeight]{#1}}%
\fi
\noindent\vbox{\hbox to\linewidth{\hfil\usebox{\LitDiagramBox}\hfil}\kern0pt}%
\par\endgroup\addvspace{6pt}}`;
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
function documentAnchor(block: Extract<PandocBlock, { t: 'Div' }>, theme: LiterateTheme): PandocBlock {
    const [attributes, contents] = block.c;
    const children = ordinaryCode(contents, theme);
    if (/^d-(?:[0-9a-f]{4})+$/.test(attributes[0]) && children[0]?.t === 'Header') {
        children.splice(1, 0, { t: 'RawBlock',
            c: ['latex', `\\phantomsection\\label{${attributes[0]}}`] });
        return { t: 'Div', c: [['', attributes[1], attributes[2]], children] };
    }
    return { t: 'Div', c: [attributes, children] };
}
function inlineCode(inlines: PandocInline[]): PandocInline[] {
    return inlines.map(inline => {
        if (inline.t === 'Code') {
            const characters = Array.from(inline.c[1]);
            const text = characters.map((character, index) => {
                if (character === ' ') { return '\\hspace{\\fontdimen2\\font}\\allowbreak{}'; }
                const boundary = index > 0 && /^[!-~]$/.test(characters[index - 1]) && /^[!-~]$/.test(character);
                return (boundary ? '\\allowbreak{}' : '') + tex(character);
            }).join('');
            return rawInline(`\\LitInlineCode{${text}}`);
        }
        if (inline.t === 'Emph' || inline.t === 'Strong' || inline.t === 'Strikeout') {
            return { ...inline, c: inlineCode(inline.c) };
        }
        if (inline.t === 'Link') {
            return { ...inline, c: [inline.c[0], inlineCode(inline.c[1]), inline.c[2]] };
        }
        return inline;
    });
}
function ordinaryCode(blocks: PandocBlock[], theme: LiterateTheme): PandocBlock[] {
    return blocks.map(block => {
        switch (block.t) {
            case 'Para': case 'Plain': return { ...block, c: inlineCode(block.c) };

            case 'CodeBlock': {
                const text = block.c[1];
                const data: Highlighted = { text, references: [],
                    spans: text ? [{ start: 0, end: text.length, scope: '' }] : [] };
                return { t: 'RawBlock', c: ['latex', literal(data, 0, text.length, theme)] };
            }
            case 'Div': return documentAnchor(block, theme);
            case 'BlockQuote': return { ...block, c: ordinaryCode(block.c, theme) };
            case 'BulletList': return { ...block, c: block.c.map(item => ordinaryCode(item, theme)) };
            case 'OrderedList': return { ...block,
                c: [block.c[0], block.c[1].map(item => ordinaryCode(item, theme))] };
            default: return block;
        }
    });
}
function imageBlock(asset: PublicationAsset, resolve: (asset: PublicationAsset) => string): PandocBlock[] {
    const file = resolve(asset);
    if (!/^lit-assets-[a-f0-9]{64}\/[a-f0-9]{64}\.(png|jpg|pdf)$/.test(file)) {
        throw new Error('Image adapter must return a safe publication companion path');
    }
    if (Array.from(asset.caption).length > 4096) { throw new Error('Image caption exceeds 4096 characters'); }
    return [{ t: 'RawBlock', c: ['latex', asset.kind === 'mermaid'
        ? `\\LitDiagram{${file}}` : `\\LitImage{${file}}{${tex(asset.caption)}}`] }];
}
function contribution(part: PublicationContribution, project: ParsedProject,
    theme: LiterateTheme, definitions: string[]): PandocBlock[] {
    const family = project.publication.fragments.find(item => item.target === part.fragmentTarget);
    if (!family) { throw new Error('Contribution has no fragment family'); }
    if (!family.contributions.includes(part.target)) { throw new Error('Contribution is absent from its family'); }
    const data = highlightContribution(part);
    validateHighlight(data);
    mergeStyles(data, theme);
    let output = '\\par\\addvspace{\\parskip}\\Needspace{5\\baselineskip}\n\\begingroup\n' +
        '\\leftskip=1.5em\\rightskip=0pt plus 1fil\\parindent=0pt\\parskip=0pt' +
        '\\fvset{xleftmargin=1.5em,listparameters={\\setlength{\\topsep}{0pt}' +
        '\\setlength{\\partopsep}{0pt}\\setlength{\\parsep}{0pt}\\setlength{\\itemsep}{0pt}}}\n' + anchor(part.target);
    if (part.kind === 'definition') { output += anchor(family.target); }
    output += `{\\fragmentfont\\raggedright\\color{publicationAccent} ${nameText(family.name)}` +
        `\\enspace\\ensuremath{${part.kind === 'definition' ? '\\equiv' : '+\\equiv'}}\\par}\n`;
    output += contributionBody(data, project, theme, definitions) + '\\par\\endgroup\n';
    return [{ t: 'RawBlock', c: ['latex', output] }];
}
function fragmentPageLink(family: ParsedProject['publication']['fragments'][number], label: string): string {
    if (!family.contributions.length) { throw new Error('Referenced fragment has no contributions'); }
    const pages = family.contributions.map(id => {
        const destination = target(id);
        return `\\hyperref[${destination}]{\\pageref*{${destination}}}`;
    }).join(',\\allowbreak{} ');
    return `\\hyperref[${target(family.contributions[0])}]{${label}}` +
        `\\textsuperscript{\\notefont ${pages}}`;
}
function contributionBody(data: Highlighted, project: ParsedProject,
    theme: LiterateTheme, definitions: string[]): string {
    let cursor = 0, output = '';
    for (const reference of data.references) {
        const family = project.publication.fragments.find(item =>
            item.target === reference.target && item.name === reference.name);
        if (!family) { throw new Error('Unknown highlighted reference destination'); }
        const standalone = reference.placement === 'standalone';
        output += literal(data, cursor,
            standalone ? referencePrefixEnd(data.text, cursor, reference.start) : reference.start, theme);
        const command = macroName(definitions.length);
        const label = '\\textless{}\\textless{}' + nameText(reference.name) +
            '\\textgreater{}\\textgreater{}';
        const marker = reference.annotation === 'rail' ?
            `\\LitFragmentUse{${target(reference.occurrenceTarget)}}{${target(reference.target)}}` : '';
        definitions.push(`\\newcommand{\\${command}}{\\par\\begingroup` +
            (standalone ? '' : '\\leftskip=1.5em\\rightskip=0pt plus 1fil\\parindent=0pt') +
            '\\ttfamily\\LitCodeSize\\noindent ' + marker + fragmentPageLink(family, label) +
            '\\par\\endgroup}');
        output += `\\${command}{}\n`;
        if (standalone) {
            const newline = data.text.indexOf('\n', reference.end);
            cursor = newline < 0 ? data.text.length : newline + 1;
        } else { cursor = reference.end + (data.text[reference.end] === '\n' ? 1 : 0); }
    }
    return output + literal(data, cursor, data.text.length, theme);
}
function referencePrefixEnd(text: string, cursor: number, start: number): number {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    return /^[ \t]*$/.test(text.slice(lineStart, start)) ? Math.max(cursor, lineStart) : start;
}
const conversionOptions: LatexConversionOptions = {
    standalone: false, syntaxHighlighting: 'none', topLevelDivision: 'chapter'
};
function rawInline(value: string): PandocInline { return { t: 'RawInline', c: ['latex', value] }; }
function annotationInlines(inlines: PandocInline[], project: ParsedProject,
    markers: boolean, next: () => string): PandocInline[] {
    return inlines.flatMap((inline): PandocInline[] => {
        if (inline.t === 'Link') {
            const label = annotationInlines(inline.c[1], project, markers, next);
            if (inline.c[0][1].includes('lit-fragment-use')) {
                const values = new Map(inline.c[0][2]);
                const family = project.publication.fragments.find(item => item.target === values.get('data-target'));
                if (!family) { throw new Error('Prose fragment reference family is missing'); }
                const marker = markers && values.get('data-annotation') === 'rail' ?
                    `\\LitFragmentUse{${target(values.get('data-occurrence') || '')}}{${target(family.target)}}` : '';
                const name = '\\textless{}\\textless{}' + nameText(family.name) +
                    '\\textgreater{}\\textgreater{}';
                return [rawInline(marker + fragmentPageLink(family, name))];
            }
            if (!inline.c[0][1].includes('lit-term-use')) { return [{ ...inline, c: [inline.c[0], label, inline.c[2]] }]; }
            const id = target(inline.c[2][0].slice(1));
            const opening = (markers ? `\\LitTermUse{${next()}}{${id}}{` : '') + `\\hyperref[${id}]{`;
            const closing = `\\textsuperscript{\\notefont\\pageref*{${id}}}}` + (markers ? '}' : '');
            return [rawInline(opening), ...label, rawInline(closing)];
        }
        if (inline.t === 'Emph' || inline.t === 'Strong' || inline.t === 'Strikeout') {
            return [{ ...inline, c: annotationInlines(inline.c, project, markers, next) }];
        }
        return [inline];
    });
}
const maximumAnnotationBody = 131072;
const maximumAnnotationContent = 2 * 1024 * 1024;
interface AnnotationBudget { terms: RailTerm[]; fragments: RailFragment[]; size: number; }
function annotationText(value: string): void {
    if (typeof value !== 'string' || value.length > maximumAnnotationBody ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new Error('Invalid or oversized controlled rail LaTeX (maximum 131072 characters)');
    }
}
function annotationSize(size: number): void {
    if (size > maximumAnnotationContent) { throw new Error('Annotation content exceeds 2 MiB'); }
}
function annotationTarget(value: string): string {
    if (4 + value.length * 4 > 8192) { throw new Error('Encoded rail target exceeds 8192 characters'); }
    return target(value);
}
function railFragmentFamilies(project: ParsedProject): ParsedProject['publication']['fragments'] {
    const used = new Set<string>();
    for (const contribution of project.publication.contributions) {
        for (const segment of contribution.segments) {
            if (segment.kind === 'reference' && segment.annotation === 'rail' &&
                segment.resolution.kind === 'resolved') { used.add(segment.resolution.target); }
        }
    }
    for (const reference of project.publication.proseReferences || []) {
        if (reference.annotation === 'rail' && reference.resolution.kind === 'resolved') {
            used.add(reference.resolution.target);
        }
    }
    return project.publication.fragments.filter(family => used.has(family.target));
}
function annotationBudget(project: ParsedProject): AnnotationBudget {
    const { terms, notes } = project.annotations;
    const fragmentFamilies = railFragmentFamilies(project);
    if (terms.length > 1000 || notes.length > 1000 || fragmentFamilies.length > 1000 ||
        terms.length + notes.length + fragmentFamilies.length > 3000) {
        throw new Error('Rail supports at most 1000 terms, notes and fragments, and 3000 declarations total');
    }
    const fragmentLabelCount = fragmentFamilies.reduce((sum, family) => sum + family.contributions.length, 0);
    if (fragmentLabelCount > 10000) {
        throw new Error('Rail supports at most 10000 fragment contribution labels');
    }
    let sourceSize = 0, size = 0;
    for (const item of [...terms, ...notes]) {
        if (item.body.length > maximumAnnotationBody) {
            throw new Error('Annotation source body exceeds 131072 characters');
        }
        sourceSize += item.body.length;
        annotationSize(sourceSize);
    }
    const declarations = terms.map(term => {
        const id = annotationTarget(term.target), title = tex(term.title);
        annotationText(title);
        size += 2 * id.length + title.length;
        annotationSize(size + sourceSize);
        return { target: id, title, label: id };
    });
    for (const note of notes) {
        size += annotationTarget(note.target).length;
        annotationSize(size + sourceSize);
    }
    const fragments = fragmentFamilies.map(family => {
        const id = annotationTarget(family.target), title = nameText(family.name);
        const labels = family.contributions.map(annotationTarget);
        annotationText(title);
        size += id.length + title.length + labels.reduce((sum, label) => sum + label.length, 0);
        annotationSize(size + sourceSize);
        return { target: id, title, labels };
    });
    return { terms: declarations, fragments, size };
}
async function annotationLatex(document: PandocDocument, project: ParsedProject,
    convert: LatexConverter, budget: AnnotationBudget, railFontSize: number): Promise<string> {
    const notes: RailNote[] = [];
    let occurrence = 0;
    const next = (): string => `lit-use-${++occurrence}`;
    const raw = (value: string): PandocBlock => ({ t: 'RawBlock', c: ['latex', value] });
    const walk = async (blocks: PandocBlock[], markers: boolean): Promise<PandocBlock[]> => {
        const result: PandocBlock[] = [];
        for (const block of blocks) {
            if (block.t === 'Div') {
                const term = project.annotations.terms.find(item => item.target === block.c[0][0]);
                const note = project.annotations.notes.find(item => item.target === block.c[0][0]);
                const children = await walk(block.c[1], markers && !term && !note);
                if (note) {
                    const body = children.length ? await convert({ ...document, blocks: children }, conversionOptions) : '';
                    annotationText(body);
                    budget.size += body.length;
                    annotationSize(budget.size);
                    notes.push({ target: target(note.target), number: note.number, body });
                    result.push(raw(`\\LitNoteUse{${target(note.target)}}`));
                } else if (term) {
                    const first = children.find(child => child.t === 'Para' || child.t === 'Plain');
                    if (first) {
                        const summary = await convert({ ...document, blocks: [first] }, conversionOptions);
                        annotationText(summary);
                        budget.size += summary.length;
                        annotationSize(budget.size);
                        const declaration = budget.terms.find(item => item.target === target(term.target));
                        if (!declaration) { throw new Error('TERM rail declaration is missing'); }
                        declaration.summary = summary;
                    }
                    result.push(raw(`\\par${anchor(term.target)}\\textbf{${tex(term.title)}}\\par`), ...children);
                } else { result.push({ ...block, c: [block.c[0], children] }); }
            } else { result.push(await ordinary(block, markers)); }
        }
        return result;
    };
    const items = async (list: PandocBlock[][], markers: boolean): Promise<PandocBlock[][]> => {
        const result: PandocBlock[][] = [];
        for (const item of list) { result.push(await walk(item, markers)); }
        return result;
    };
    const ordinary = async (block: PandocBlock, markers: boolean): Promise<PandocBlock> => {
        switch (block.t) {
            case 'Para': case 'Plain': return { ...block, c: annotationInlines(block.c, project, markers, next) };
            case 'Header': return { ...block,
                c: [block.c[0], block.c[1], annotationInlines(block.c[2], project, markers, next)] };
            case 'BlockQuote': return { ...block, c: await walk(block.c, markers) };
            case 'BulletList': return { ...block, c: await items(block.c, markers) };
            case 'OrderedList': return { ...block,
                c: [block.c[0], await items(block.c[1], markers)] };
            default: return block;
        }
    };
    document.blocks = await walk(document.blocks, true);
    const terms = budget.terms, fragments = budget.fragments;
    if (!terms.length && !notes.length && !fragments.length) { return ''; }
    return '% literate-publication-rail-v1\n' +
        '\\setlength{\\marginparwidth}{25mm}\n\\setlength{\\marginparsep}{5mm}\n' +
        '\\microtypesetup{protrusion=false}\n' + publicationRail(terms, notes, railFontSize, fragments);
}
function annotationIndexes(project: ParsedProject): string {
    let output = '';
    if (project.annotations.terms.length) {
        output += '\n\\chapter*{Term index}\n';
        for (const term of project.annotations.terms) {
            output += pageLink(term.target, tex(term.title)) + '\\par\n';
        }
    }
    if (project.publication.fragments.length) {
        output += '\n\\chapter*{Fragment index}\n';
        for (const family of project.publication.fragments) {
            output += `{\\fragmentfont ${nameText(family.name)}}\\quad ` +
                family.contributions.map(id => pageLink(id, '')).join(', ') + '\\par\n';
        }
    }
    return output;
}
export async function renderLatex(parsed: ParsedProject, options: LatexOptions,
    convert: LatexConverter): Promise<LatexResult> {
    let stage = 'latex-options';
    try {
        const settings = resolvePublicationSettings(parsed);
        if (settings.diagnostics.length) {
            return { diagnostics: [...parsed.diagnostics, ...settings.diagnostics] };
        }
        const hasRail = !!(parsed.annotations.terms.length || parsed.annotations.notes.length ||
            railFragmentFamilies(parsed).length);
        const checked = checkOptions(options, settings, hasRail);
        const definitions: string[] = [];
        stage = 'latex-preparation';
        const budget = annotationBudget(parsed);
        const prepared = preparePandoc(parsed, part =>
            contribution(part, parsed, checked.theme, definitions), options.assetPath
                ? asset => imageBlock(asset, options.assetPath!) : undefined, options.publicationLink);
        if (!prepared.document) { return { diagnostics: prepared.diagnostics }; }
        prepared.document.blocks = ordinaryCode(prepared.document.blocks, checked.theme);
        stage = 'latex-conversion';
        const annotations = await annotationLatex(prepared.document, parsed, convert, budget,
            checked.railFontSize);
        const body = await convert(prepared.document, conversionOptions);
        if (typeof body !== 'string') { throw new Error('Converter must return a LaTeX body string'); }
        stage = 'latex-template';
        return { latex: template(body + (hasRail ? annotationIndexes(parsed) : ''),
            checked, definitions, annotations), diagnostics: [] };
    } catch (error) {
        return { diagnostics: [{ path: parsed.documents[0]?.path ?? '', line: 0, column: 0,
            code: stage, message: error instanceof Error ? error.message : String(error) }] };
    }
}
