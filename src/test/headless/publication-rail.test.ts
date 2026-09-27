import assert = require('node:assert/strict');
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { publicationRail, RailNote, RailTerm } from '../../publication-rail';

const term: RailTerm = { target: 'annotation-term-0061', title: 'Alpha', label: 'lit-00610062' };
const note: RailNote = { target: 'annotation-note-0062', number: 1, body: 'An explanation.\\par Another paragraph.' };
function runtime(tex: string): string {
    const loader = tex.slice(0, tex.indexOf('\n\\makeatletter'));
    assert.match(loader, /^\\directlua\{assert\(load\(/);
    return [...loader.matchAll(/string\.char\(([\d,]+)\)/g)]
        .map(match => String.fromCharCode(...match[1].split(',').map(Number))).join('');
}

test('rail is absent without annotations and does not mutate inputs', () => {
    assert.equal(publicationRail([], []), '');
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
    assert.ok(tex.includes(`\\LitRailBuild{1}{A}{${term.label}}`));
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
    for (const number of [0, -1, 1.5, NaN, Infinity, 10001]) {
        assert.throws(() => publicationRail([], [{ ...note, number }]), /unique integers/);
    }
    assert.throws(() => publicationRail([], [note, { ...note, target: 'other' }]), /unique integers/);
});

test('rail bounds declarations, controlled text and runtime work', () => {
    assert.throws(() => publicationRail(Array(1001).fill(term), []), /1000 terms/);
    assert.throws(() => publicationRail([], Array(1001).fill(note)), /1000 notes/);
    assert.throws(() => publicationRail([{ ...term, title: '\0' }], []), /controlled rail/);
    assert.throws(() => publicationRail([], [{ ...note, body: 'x'.repeat(131073) }]), /controlled rail/);
    assert.throws(() => publicationRail([], Array.from({ length: 17 }, (_,index) => ({
        target: `n-${index}`, number: index + 1, body: 'x'.repeat(131072)
    }))), /2 MiB/);
    const lua = runtime(publicationRail([term], [note]));
    for (const limit of ['R.count>=10000', 'R.nodes>500000', 'depth>64', 'R.page>100000']) {
        assert.ok(lua.includes(limit), limit);
    }
});

test('rail uses one absolute-page stream with stable-state errors and a release certificate', () => {
    const tex = publicationRail([term], [note]);
    const lua = runtime(tex);
    for (const part of ['pdf.getpos()', 'seen[r[2]]', 'table.sort(records', 'item.d.height',
        'R.bounds', 'R.pages', 'R.fingerprints', 'R.problems', 'R.oldhash', 'horizontal protrusion',
        'overflow on absolute page', 'duplicate occurrence', 'unshipped annotation', '.litrail']) {
        assert.ok(lua.includes(part), part);
    }
    assert.match(lua, /if hash==R\.oldhash and #R\.problems>0 then fatal/);
    assert.ok(tex.includes('\\AddToHook{enddocument/afterlastpage}'));
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

test('owning literate fragments exactly match the TypeScript without running generation', () => {
    const source = readFileSync(resolve('literate/publication-rail.literate'), 'utf8');
    const blocks = new Map([...source.matchAll(/^```ts : <<([^>]+)>>=.*\n([\s\S]*?)^```/gm)]
        .map(match => [match[1], match[2]]));
    const expand = (name: string): string => {
        const block = blocks.get(name);
        assert.notEqual(block, undefined, name);
        return block!.replace(/^<<([^>]+)>>\n/gm, (_, nested: string) => expand(nested));
    };
    assert.equal(expand('publication rail.*'), readFileSync(resolve('src/publication-rail.ts'), 'utf8'));
});
