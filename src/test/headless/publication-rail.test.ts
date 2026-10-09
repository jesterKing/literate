import assert = require('node:assert/strict');
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { publicationRail, RailFragment, RailNote, RailTerm } from '../../publication-rail';
import { generatedFromBook } from './authoritative-book';

const term: RailTerm = { target: 'annotation-term-0061', title: 'Alpha', label: 'lit-00610062' };
const note: RailNote = { target: 'annotation-note-0062', number: 1, body: 'An explanation.\\par Another paragraph.' };
const fragment: RailFragment = { target: 'f-0063', title: 'A fragment', labels: ['c-0063-1', 'c-0063-2'] };
function runtime(tex: string): string {
    const loader = tex.slice(0, tex.indexOf('\n\\makeatletter'));
    assert.match(loader, /^\\directlua\{assert\(load\(/);
    return [...loader.matchAll(/string\.char\(([\d,]+)\)/g)]
        .map(match => String.fromCharCode(...match[1].split(',').map(Number))).join('');
}

test('rail is absent without annotations and does not mutate inputs', () => {
    assert.equal(publicationRail([], []), '');
    assert.equal(publicationRail([], [], 9, []), '');
    const terms = Object.freeze([Object.freeze({ ...term })]);
    const notes = Object.freeze([Object.freeze({ ...note })]);
    assert.equal(publicationRail(terms, notes), publicationRail([term], [note]));
});

test('rail keeps model targets separate from pre-encoded definition labels', () => {
    const tex = publicationRail([term], [note]);
    assert.ok(tex.includes(`\\hyperref[${term.label}]{\\textbf{Alpha}\\space\\pageref*{${term.label}}}`));
    assert.ok(runtime(tex).includes(`litrail.declare(1,"${term.target}","term",0)`));
    assert.ok(runtime(tex).includes(`litrail.declare(2,"${note.target}","note",1)`));
    assert.ok(tex.includes('\\textbf{1.}\\space ' + note.body));
    assert.ok(tex.includes(`\\def\\LitRailLabelsA{\\LitRailResolve{${term.label}}}`));
    assert.ok(tex.includes('\\LitRailBuild{1}{A}{2}'));
});

test('fragment rows link every contribution and expose a marker-only use command', () => {
    const tex = publicationRail([], [], 9, [fragment]);
    const lua = runtime(tex);
    assert.ok(lua.includes(`litrail.declare(1,"${fragment.target}","fragment",0)`));
    for (const label of fragment.labels) {
        assert.ok(tex.includes(`\\LitRailResolve{${label}}`));
        assert.ok(tex.includes(`\\hyperref[${label}]{\\pageref*{${label}}}`));
    }
    assert.ok(tex.includes('\\LitRailBuild{1}{A}{0.75}'));
    const macro = tex.slice(tex.indexOf('\\DeclareRobustCommand{\\LitFragmentUse}'),
        tex.indexOf('\\AddToHook{begindocument/end}'));
    assert.match(macro, /litrail\.use\(/);
    assert.doesNotMatch(macro, /\\hyperref|\\hyperlink|\\pageref|A fragment/);
    assert.ok(lua.includes('seen[r[2]]'));
    assert.ok(lua.includes('d.kind=="note" and seen[r[2]]'));
    assert.ok(lua.includes('lit-rail-fragment-'));
});

test('term macro renders its supplied label once without adding an inline link or page number', () => {
    const tex = publicationRail([term], []);
    const macro = tex.slice(tex.indexOf('\\DeclareRobustCommand{\\LitTermUse}'),
        tex.indexOf('\\DeclareRobustCommand{\\LitNoteUse}'));
    assert.equal((macro.match(/#3/g) || []).length, 1);
    assert.doesNotMatch(macro, /\\hyperref|\\hyperlink|\\pageref/);
    assert.match(macro, /litrail\.use\(/);
    assert.match(runtime(tex), /\\\\textsuperscript\{\\\\notefont /);
});

test('controlled hostile-looking titles and note text never enter the Lua loader', () => {
    const title = String.raw`\textbackslash{}directlua\{error("TITLE-INJECTION")\} \% \# \{\} café`;
    const body = String.raw`\textbackslash{}end\{document\} "BODY-INJECTION"\par \begin{itemize}\tightlist\item Safe \& escaped.\end{itemize}`;
    const tex = publicationRail([{ ...term, title }], [{ ...note, body }]);
    assert.ok(tex.includes(title)); assert.ok(tex.includes(body));
    assert.doesNotMatch(runtime(tex), /TITLE-INJECTION|BODY-INJECTION|café/);
    assert.match(runtime(tex), /token\.get_macro\(macro\)/);
    assert.doesNotMatch(tex, /\\usepackage\{luacode\}|dofile\(|os\.execute|io\.popen|shellescape/);
});

test('rail validates targets, labels, duplicate declarations and note numbers', () => {
    for (const value of ['', 'x";error(1)', 'a\\b', 'a{b}', 'a%b', 'a b', 'é', 'a'.repeat(8193)]) {
        assert.throws(() => publicationRail([{ ...term, target: value }], []), /safe ASCII/);
        assert.throws(() => publicationRail([{ ...term, label: value }], []), /safe ASCII/);
        assert.throws(() => publicationRail([], [{ ...note, target: value }]), /safe ASCII/);
    }
    assert.throws(() => publicationRail([term, term], []), /Duplicate rail target/);
    assert.throws(() => publicationRail([term, { ...term, target: 'other' }], []), /Duplicate rail definition label/);
    assert.throws(() => publicationRail([term], [{ ...note, target: term.target }]), /Duplicate rail target/);
    assert.throws(() => publicationRail([term], [], 9, [{ ...fragment, target: term.target }]), /Duplicate rail target/);
    assert.throws(() => publicationRail([term], [], 9,
        [{ ...fragment, labels: [term.label] }]), /Duplicate rail definition label/);
    assert.throws(() => publicationRail([], [], 9, [{ ...fragment, labels: [] }]), /at least one/);
    for (const number of [0, -1, 1.5, NaN, Infinity, 10001]) {
        assert.throws(() => publicationRail([], [{ ...note, number }]), /unique integers/);
    }
    assert.throws(() => publicationRail([], [note, { ...note, target: 'other' }]), /unique integers/);
});

test('rail bounds declarations, controlled text and runtime work', () => {
    assert.throws(() => publicationRail(Array(1001).fill(term), []), /1000 terms, notes and fragments/);
    assert.throws(() => publicationRail([], Array(1001).fill(note)), /1000 terms, notes and fragments/);
    assert.throws(() => publicationRail([], [], 9, Array(1001).fill(fragment)), /1000 terms, notes and fragments/);
    assert.throws(() => publicationRail([], [], 9, [{ ...fragment,
        labels: Array.from({ length: 10001 }, (_, index) => `c-${index}`) }]), /10000 fragment/);
    assert.throws(() => publicationRail([{ ...term, title: '\0' }], []), /controlled rail/);
    assert.throws(() => publicationRail([], [{ ...note, body: 'x'.repeat(131073) }]), /controlled rail/);
    assert.throws(() => publicationRail([], Array.from({ length: 17 }, (_,index) => ({
        target: `n-${index}`, number: index + 1, body: 'x'.repeat(131072)
    }))), /2 MiB/);
    const lua = runtime(publicationRail([term], [note], 9, [fragment]));
    for (const limit of ['R.count>=10000', 'R.nodes>500000', 'depth>64', 'page>100000',
        'definition>3000', 'kind~="fragment"', 'token.get_macro(labelsmacro)']) {
        assert.ok(lua.includes(limit), limit);
    }
});

test('rail font size is bounded and controls explicit point size and leading', () => {
    assert.ok(publicationRail([term], [], 9).includes('\\fontsize{9pt}{10.8pt}'));
    assert.ok(publicationRail([term], [], 12.5).includes('\\fontsize{12.5pt}{15pt}'));
    for (const value of [6.99, 14.01, NaN, Infinity]) {
        assert.throws(() => publicationRail([term], [], value), /7–14 points/);
    }
});

test('rail uses physical shipout parity with stable-state errors and a release certificate', () => {
    const tex = publicationRail([term], [note]);
    const lua = runtime(tex);
    for (const part of ['pdf.getpos()', 'seen[r[2]]', 'table.sort(records', 'item.d.height',
        'R.bounds', 'R.pages', 'R.fingerprints', 'R.problems', 'R.oldhash', 'horizontal protrusion',
        'overflow on absolute page', 'duplicate occurrence', 'unshipped annotation', '.litrail']) {
        assert.ok(lua.includes(part), part);
    }
    assert.match(lua, /if hash==R\.oldhash and #R\.problems>0 then fatal/);
    assert.ok(tex.includes('\\AddToHook{enddocument/afterlastpage}'));
    assert.ok(tex.includes('\\ReadonlyShipoutCounter'));
    assert.ok(tex.includes('\\oddsidemargin'));
    assert.ok(tex.includes('\\evensidemargin'));
    assert.doesNotMatch(tex, /two-sided rail unsupported|\\value\{page\}|\\thepage/);
    assert.ok(lua.includes('page~=R.page+1'));
    assert.ok(lua.includes('twoside==1 and page%2==0'));
    assert.ok(lua.includes('evenleft-separation-width'));
    assert.ok(tex.includes('\\immediate\\write\\@auxout'));
    assert.ok(lua.includes('Rerun to get rail membership, dimensions and references right'));
    assert.ok(lua.includes('width-tex.sp("25mm")'));
    assert.ok(lua.includes('separation-tex.sp("5mm")'));
    assert.doesNotMatch(tex, /\\marginpar\{|\\insert\b|\\resizebox|\\scalebox/);
});

test('box macro names remain alphabetic beyond the first 26 declarations', () => {
    const notes = Array.from({ length: 28 }, (_, index) => ({ ...note, target: `note-${index}`, number: index + 1 }));
    const tex = publicationRail([], notes);
    assert.ok(tex.includes('\\LitRailBodyZ{'));
    assert.ok(tex.includes('\\LitRailBodyAA{'));
    assert.ok(tex.includes('\\LitRailBodyAB{'));
});

test('authoritative book exactly assembles the publication rail', () => {
    assert.equal(generatedFromBook('src/publication-rail.ts').content,
        readFileSync(resolve('src/publication-rail.ts'), 'utf8'));
});
