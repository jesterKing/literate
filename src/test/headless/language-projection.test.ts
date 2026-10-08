/* Fixture dictionaries intentionally use filesystem paths as property names. */
/* eslint-disable @typescript-eslint/naming-convention */
import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateProject, SourceDocument } from '../../engine';
import { projectLanguageSources, mapSourcePosition, mapGeneratedRange } from '../../language-projection';
import { generatedFromBook } from './authoritative-book';

const fence = (header: string, body: string) => '```' + header + '\n' + body + '\n```\n';
const document = (text: string): SourceDocument => ({ path: 'index.literate', text });

function parity(documents: SourceDocument[], templates: Record<string, string> = {}) {
    const result = projectLanguageSources(documents, templates);
    assert.deepEqual(result.diagnostics, []);
    const generated = generateProject(documents, templates);
    assert.deepEqual(generated.diagnostics, []);
    assert.deepEqual(result.files.map(({ path, content }) => ({ path, content })),
        generated.files.filter(file => !file.path.endsWith('.html')));
    return result.files;
}

test('owned chapters assemble in memory to their checked-in TypeScript outputs', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const name of ['engine', 'language-projection']) {
        const output = 'src/' + name + '.ts';
        assert.equal(generatedFromBook(output).content, fs.readFileSync(path.join(root, output), 'utf8'));
    }
});

test('complete self-hosting project projects and maps this.list through its source template', () => {
    const root = path.resolve(__dirname, '../../..');
    const paths = ['index.literate', ...fs.readdirSync(path.join(root, 'literate'))
        .filter(name => name.endsWith('.literate')).sort().map(name => 'literate/' + name)];
    const documents = paths.map(sourcePath => ({ path: sourcePath,
        text: fs.readFileSync(path.join(root, sourcePath), 'utf8') }));
    const templates = { 'tssrc.template': fs.readFileSync(path.join(root, 'tssrc.template'), 'utf8') };
    const files = parity(documents, templates);
    const source = documents.find(document => document.path === 'literate/literate.literate')!;
    const offset = source.text.indexOf('this.list');
    assert.ok(offset >= 0);
    const hit = mapSourcePosition(files, source.path, offset);
    assert.ok(hit);
    assert.equal(hit.file.path, 'src/extension.ts');
    assert.equal(hit.file.content.slice(hit.offset, hit.offset + 'this.list'.length), 'this.list');
    assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset + 'this.list'.length, hit.mapping),
        { start: offset, end: offset + 'this.list'.length });
});

test('parity across documents, ordered appends, multiple outputs, repeated and nested references', () => {
    const documents = [document(fence('ts: <<main.*>>= main.ts $', 'prefix <<piece>> suffix\n\t<<piece>>\n\\<<literal>>')
        + fence('ts: <<second.*>>= second.ts $', '<<leaf>>')
        + fence(': <<piece>>=', 'A\n  <<leaf>>')),
    { path: 'z.literate', text: fence(': <<piece>>=+', 'appended') + fence(': <<leaf>>=', '😀leaf\nnext') }];
    const files = parity(documents);
    assert.deepEqual(files.map(file => file.language), ['ts', 'ts']);
    const sourceOffset = documents[1].text.indexOf('😀leaf');
    const hit = mapSourcePosition(files, './z.literate', sourceOffset + 2)!;
    assert.equal(hit.file.content.slice(hit.offset, hit.offset + 4), 'leaf');
    assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset + 4, hit.mapping), { start: sourceOffset + 2, end: sourceOffset + 6 });
    const repeats = hit.file.mappings.filter(mapping => mapping.sourcePath === 'z.literate' && mapping.sourceStart === sourceOffset);
    assert.equal(repeats.length, 2);
    assert.equal(mapGeneratedRange(hit.file, repeats[1].generatedStart, repeats[1].generatedEnd, hit.mapping), undefined);
    assert.equal(mapGeneratedRange(files[1], hit.offset, hit.offset, hit.mapping), undefined);
    assert.equal(mapGeneratedRange(hit.file, hit.offset, hit.offset, { ...hit.mapping }), undefined);
});

test('LF, CRLF, and CR retain UTF-16 positions, empty-line and end-text cursors', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
        const text = fence('ts: <<main.*>>= main.ts $', '😀value\n\nend').replace(/\n/g, eol);
        const files = parity([document(text)]);
        for (const offset of [text.indexOf('😀value') + 2, text.indexOf('😀value') + 7,
            text.indexOf(eol + eol) + eol.length, text.indexOf('end') + 3]) {
            const hit = mapSourcePosition(files, 'index.literate', offset);
            assert.ok(hit, 'cursor at ' + offset + ' with ' + JSON.stringify(eol));
            assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset, hit.mapping), { start: offset, end: offset });
        }
    }
});

test('container indentation and partially stripped tabs map only unchanged literal suffixes', () => {
    const text = ['> - ```ts: <<main.*>>= main.ts $', '>   \t😀name', '>   ', '>   ```',
        '', '  ```ts: <<main.*>>=+', '  tail', '  ```'].join('\r\n');
    const files = parity([document(text)]);
    for (const word of ['😀name', 'tail']) {
        const start = text.indexOf(word);
        const hit = mapSourcePosition(files, 'index.literate', start)!;
        assert.ok(hit);
        assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset + word.length, hit.mapping), { start, end: start + word.length });
    }
    assert.equal(mapSourcePosition(files, 'index.literate', text.indexOf('>   \t')), undefined);
});

test('headers, prose, tags, escapes, indentation and range seams are not editable code', () => {
    const text = 'Prose\n' + fence('ts: <<main.*>>= main.ts $', 'before <<piece>> after\n\\<<escaped>>')
        + fence(': <<piece>>=', 'one\ntwo');
    const files = parity([document(text)]);
    for (const offset of [0, text.indexOf('main.*'), text.indexOf('<<piece>>'), text.indexOf('<<piece>>') + 3,
        text.indexOf('\\<<escaped>>')]) {
        assert.equal(mapSourcePosition(files, 'index.literate', offset), undefined);
    }
    const hit = mapSourcePosition(files, 'index.literate', text.indexOf('before'))!;
    assert.equal(mapGeneratedRange(hit.file, hit.offset, hit.file.content.indexOf('after') + 5, hit.mapping), undefined);
    const escaped = mapSourcePosition(files, 'index.literate', text.indexOf('<<escaped>>'))!;
    assert.equal(escaped.file.content.slice(escaped.offset, escaped.offset + 11), '<<escaped>>');
    assert.equal(mapSourcePosition(files, 'index.literate', -1), undefined);
    assert.equal(mapSourcePosition(files, 'index.literate', 1.5), undefined);
    assert.equal(mapGeneratedRange(hit.file, hit.offset + 2, hit.offset, hit.mapping), undefined);
});

test('empty referenced lines and unterminated source text retain cursor anchors', () => {
    const text = fence('ts: <<main.*>>= main.ts $', '<<blank>>') + fence(': <<blank>>=', '');
    const files = parity([document(text)]);
    const offset = text.indexOf('<<blank>>=') + '<<blank>>=\n'.length;
    const hit = mapSourcePosition(files, 'index.literate', offset)!;
    assert.ok(hit);
    assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset, hit.mapping), { start: offset, end: offset });
    const unfinished = '```ts: <<main.*>>= main.ts $\nlast😀';
    const endHit = mapSourcePosition(parity([document(unfinished)]), 'index.literate', unfinished.length)!;
    assert.ok(endHit);
    const emptyEof = '```ts: <<main.*>>= main.ts $\n';
    assert.ok(mapSourcePosition(parity([document(emptyEof)]), 'index.literate', emptyEof.length));
});

test('empty EOF appends preserve anchors without hiding the child trailing newline', () => {
    for (const suffix of ['', ' after']) {
        const text = fence('ts: <<main.*>>= main.ts $', '<<child>>' + suffix)
            + fence(': <<child>>=', 'x') + '``` : <<child>>=+\n';
        const files = parity([document(text)]);
        assert.equal(files[0].content, 'x' + suffix + '\n');
        const hit = mapSourcePosition(files, 'index.literate', text.length)!;
        assert.ok(hit);
        assert.equal(hit.offset, 1);
        assert.deepEqual(mapGeneratedRange(hit.file, hit.offset, hit.offset, hit.mapping),
            { start: text.length, end: text.length });
        if (suffix) {
            const after = mapSourcePosition(files, 'index.literate', text.indexOf(' after'))!;
            assert.equal(after.offset, 1);
            assert.deepEqual(mapGeneratedRange(after.file, after.offset, after.offset + suffix.length, after.mapping),
                { start: text.indexOf(' after'), end: text.indexOf(' after') + suffix.length });
        }
    }
});

test('escapes formed at expansion seams unescape only after assembly', () => {
    parity([document(fence('text: <<main.*>>= main.txt $', '\\<<left>><<right>>')
        + fence(': <<left>>=', '<') + fence(': <<right>>=', '<'))]);
    parity([document(fence('text: <<main.*>>= main.txt $', '<<slash>><<left>>')
        + fence(': <<slash>>=', '\\') + fence(': <<left>>=', '<<'))]);
});

test('invalid declarations, unused missing references, cycles and collisions fail atomically', () => {
    for (const extra of [fence(': <<unused>>=', '<<missing>>'), fence(': <<unused>>=', '<<unused>>'),
        fence(': <<unused>>=', '<<main.*>>=+'), fence(': <<main.*>>=', 'duplicate'),
        fence('ts: <<other.*>>= MAIN.ts $', 'alias'), fence('ts: <<bad.*>>= index.literate $', 'input')]) {
        const result = projectLanguageSources([document(fence('ts: <<main.*>>= main.ts $', 'valid') + extra)]);
        assert.deepEqual(result.files, []);
        assert.ok(result.diagnostics.length);
    }
});

test('valid template roots project, while missing templates block the project', () => {
    const documents = [document(fence('ts: <<plain.*>>= plain.ts $', 'plain')
        + fence('ts: <<wrapped.*>>= wrapped.ts $ template=wrapper.txt', 'wrapped'))];
    assert.deepEqual(projectLanguageSources(documents).files, []);
    assert.ok(projectLanguageSources(documents).diagnostics.length);
    const files = parity(documents, { 'wrapper.txt': '[CODE]' });
    assert.deepEqual(files.map(file => file.path), ['plain.ts', 'wrapped.ts']);
});

test('template wrappers substitute literally and map each slot independently', () => {
    const text = fence('ts: <<main.*>>= main.ts $ template=wrapper.txt',
        '😀this.list\n\\<<escaped>> $& $` $\' $$ [CODE]');
    const start = text.indexOf('😀this.list');
    for (const template of ['prefix([CODE])suffix', 'class Wrapper {\n[CODE]\n}\n',
        '😀\r\n[CODE]\r[CODE]\r\nend', '[CODE][CODE]', 'no code: $& [CONTENT]']) {
        const files = parity([document(text)], { 'wrapper.txt': template });
        const file = files[0];
        const slots = template.split('[CODE]').length - 1;
        const mappings = file.mappings.filter(mapping => mapping.sourceStart === start);
        assert.equal(mappings.length, slots);
        assert.equal(new Set(file.mappings).size, file.mappings.length);
        for (const mapping of file.mappings) {
            assert.equal(file.content.slice(mapping.generatedStart, mapping.generatedEnd),
                text.slice(mapping.sourceStart, mapping.sourceEnd));
        }
        for (const mapping of mappings) {
            assert.deepEqual(mapGeneratedRange(file, mapping.generatedStart + 2, mapping.generatedEnd, mapping),
                { start: start + 2, end: start + '😀this.list'.length });
        }
        if (!slots) {
            assert.deepEqual(file.mappings, []);
            assert.equal(mapSourcePosition(files, 'index.literate', start), undefined);
        } else {
            const hit = mapSourcePosition(files, 'index.literate', start + 2)!;
            assert.equal(hit.mapping, mappings[0]);
            assert.equal(file.content.slice(hit.offset, hit.offset + 9), 'this.list');
            assert.equal(mapSourcePosition(files, 'index.literate', text.indexOf('\\<<escaped>>')), undefined);
            assert.equal(file.content.split('<<escaped>> $& $` $\' $$ [CODE]').length - 1, slots);
            if (slots > 1) {
                assert.equal(mapGeneratedRange(file, mappings[1].generatedStart, mappings[1].generatedEnd, mappings[0]), undefined);
            }
        }
        if (template.startsWith('prefix')) {
            assert.ok(file.mappings.every(mapping => mapping.generatedStart >= 7 && mapping.generatedEnd <= file.content.length - 7));
        }
    }
});

test('template CRLF normalization spans slot seams without mapping consumed LF', () => {
    const text = fence('ts: <<main.*>>= main.ts $ template=wrapper.txt', '\n😀this.list').replace(/\n/g, '\r\n');
    for (const template of ['before\r[CODE]\r\nafter', '\r[CODE]\r[CODE]', '\r[CODE][CODE]']) {
        const files = parity([document(text)], { 'wrapper.txt': template });
        const file = files[0];
        assert.ok(!file.content.includes('\r'));
        for (const mapping of file.mappings) {
            assert.equal(file.content.slice(mapping.generatedStart, mapping.generatedEnd),
                text.slice(mapping.sourceStart, mapping.sourceEnd));
        }
        const hit = mapSourcePosition(files, 'index.literate', text.indexOf('this.list'))!;
        assert.equal(file.content.slice(hit.offset, hit.offset + 9), 'this.list');
        assert.ok(!file.mappings.some(mapping => mapping.generatedStart === 0 && mapping.generatedEnd > 0));
    }
    const empty = '```ts: <<main.*>>= main.ts $ template=wrapper.txt\n';
    assert.equal(parity([document(empty)], { 'wrapper.txt': '\r[CODE]\n' })[0].content, '\n');
});

test('template byte and repeated-slot budgets fail atomically before copying', () => {
    const documents = [document(fence('ts: <<plain.*>>= plain.ts $', 'plain')
        + fence('ts: <<main.*>>= main.ts $ template=wrapper.txt', 'this.list'))];
    for (const template of ['x'.repeat(4 * 1024 * 1024 + 1), '[CODE]'.repeat(100001),
        '[CODE]'.repeat(500000)]) {
        const result = projectLanguageSources(documents, { 'wrapper.txt': template });
        assert.deepEqual(result.files, []);
        assert.match(result.diagnostics[0].message, /limit exceeded/);
    }
});

test('expansion and depth budgets reject explosive graphs without partial files', () => {
    const text = fence('ts: <<main.*>>= main.ts $', '<<p0>>')
        + Array.from({ length: 22 }, (_, i) => fence(': <<p' + i + '>>=', i === 21 ? 'leaf' : '<<p' + (i + 1) + '>><<p' + (i + 1) + '>>')).join('');
    const result = projectLanguageSources([document(text)]);
    assert.deepEqual(result.files, []);
    assert.match(result.diagnostics[0].message, /limit exceeded/);
    const deep = fence('ts: <<main.*>>= main.ts $', '<<p0>>')
        + Array.from({ length: 140 }, (_, i) => fence(': <<p' + i + '>>=', i === 139 ? 'leaf' : '<<p' + (i + 1) + '>>')).join('');
    assert.match(projectLanguageSources([document(deep)]).diagnostics[0].message, /depth limit/);
});
