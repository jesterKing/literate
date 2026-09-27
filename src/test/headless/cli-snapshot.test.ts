import assert = require('node:assert/strict');
import { test } from 'node:test';
import * as fs from 'node:fs';
import fsPromises = require('node:fs/promises');
import * as os from 'node:os';
import * as path from 'node:path';
import { run, CliRunOptions } from '../../cli';
import { templateReferences, SourceDocument } from '../../engine';
import type { LatexConverter } from '../../publication-latex';

function fixture(t: { after(callback: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate snapshot '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
const documents = [{ path: 'index.literate', text: '# Unsaved book\n' }];
async function invoke(args: string[], snapshot: readonly SourceDocument[],
    convert: LatexConverter = async () => '\\chapter{Snapshot}\n') {
    let stdout = '', stderr = '';
    const options: CliRunOptions = { documents: snapshot };
    const code = await run([...args, '--json'], {
        stdout: text => { stdout += text; }, stderr: text => { stderr += text; }
    }, undefined, convert, undefined, undefined, options);
    assert.equal(stderr, '');
    const response = JSON.parse(stdout);
    assert.equal(response.ok, code === 0);
    return { code, response };
}

test('complete snapshot replaces disk discovery and includes unsaved sources', async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'broken.literate'), '```text: <<broken.*>>= bad.txt $\n<<missing>>\n```');
    const result = await invoke(['latex', root, '--output', 'book.tex'], Object.freeze(documents));
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.match(fs.readFileSync(path.join(root, 'book.tex'), 'utf8'), /Snapshot/);
    assert.equal(fs.existsSync(path.join(root, 'bad.txt')), false);
});

for (const name of ['../a.literate', 'a/../b.literate', './a.literate', 'a//b.literate',
    '/a.literate', 'C:/a.literate', 'a\\b.literate', 'a\u0000.literate', 'a.txt']) {
    test(`snapshot rejects noncanonical path ${JSON.stringify(name)}`, async t => {
        const root = fixture(t);
        const result = await invoke(['latex', root, '--output', 'book.tex'], [{ path: name, text: '' }]);
        assert.equal(result.code, 1);
        assert.match(result.response.errors.join(' '), /snapshot path/);
        assert.deepEqual(fs.readdirSync(root), []);
    });
}

test('snapshot rejects case-folded duplicates and malformed records', async t => {
    const root = fixture(t);
    for (const snapshot of [[...documents, { path: 'INDEX.literate', text: '' }],
        [null], [{ path: 'index.literate', text: 1 }]]) {
        const result = await invoke(['latex', root, '--output', 'book.tex'], snapshot as SourceDocument[]);
        assert.equal(result.code, 1);
        assert.deepEqual(fs.readdirSync(root), []);
    }
});

for (const command of ['generate', 'inspect', 'check', 'self-check', 'help']) {
    test(`snapshot is refused for ${command} before accessing root`, async () => {
        const result = await invoke([command, '/not-a-project'], documents);
        assert.equal(result.code, 2);
        assert.match(result.response.errors.join(' '), /only supported for latex and pdf/);
    });
}

test('empty complete snapshot does not fall back to disk', async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'index.literate'), '# Saved');
    const result = await invoke(['latex', root, '--output', 'book.tex'], []);
    assert.equal(result.code, 1);
    assert.match(result.response.errors.join(' '), /No literate/);
});

test('all supplied sources and template references remain protected', async t => {
    const root = fixture(t);
    const fragmentTemplate = [...documents, {
        path: 'unused.literate', text: '```text: <<unused.*>>= unused.txt $ template=book.tex\nUnused\n```\n'
    }];
    const rootTemplate = [{ path: 'index.literate', text: '```SETTINGS\ntemplate=book.tex\n```\n# Book\n' }];
    assert.deepEqual(templateReferences(fragmentTemplate), ['book.tex']);
    assert.deepEqual(templateReferences(rootTemplate), ['book.tex']);
    for (const snapshot of [
        [...documents, { path: 'book.tex/unused.literate', text: '# Unselected' }],
        fragmentTemplate,
        rootTemplate
    ]) {
        const result = await invoke(['latex', root, '--output', 'book.tex'], snapshot);
        assert.equal(result.code, 1, JSON.stringify(result.response));
        assert.match(result.response.errors.join(' '), /conflicts with input/);
        assert.deepEqual(fs.readdirSync(root), []);
    }
});

test('publication enumerates templates without reading their contents', async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'page.template'), 'DO NOT READ');
    const read = t.mock.method(fsPromises, 'readFile');
    const result = await invoke(['latex', root, '--output', 'book.tex'], [{
        path: 'index.literate', text: '```SETTINGS\ntemplate=page.template\n```\n# Book\n'
    }]);
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.ok(read.mock.calls.every(call => String(call.arguments[0]) !== path.join(root, 'page.template')));
});

test('PDF shares the supplied snapshot and publishes only the compiled PDF', async t => {
    const root = fixture(t);
    let stdout = '';
    const code = await run(['pdf', root, '--output', 'book.pdf', '--json'], {
        stdout: text => { stdout += text; }, stderr: () => assert.fail('Unexpected stderr')
    }, undefined, async () => '\\chapter{Snapshot}\n', undefined,
    async () => ({ pdf: Buffer.from('%PDF-snapshot'), warnings: [] }), { documents });
    assert.equal(code, 0, stdout);
    assert.deepEqual(fs.readdirSync(root), ['book.pdf']);
    assert.equal(fs.readFileSync(path.join(root, 'book.pdf'), 'utf8'), '%PDF-snapshot');
});

test('latex cancellation during conversion prevents publication and removes listeners', async t => {
    const root = fixture(t);
    const before = process.listenerCount('SIGTERM');
    const result = await invoke(['latex', root, '--output', 'book.tex'], documents, async () => {
        process.emit('SIGTERM');
        return '\\chapter{Cancelled}\n';
    });
    assert.equal(result.code, 1);
    assert.match(result.response.errors.join(' '), /cancelled/);
    assert.equal(process.listenerCount('SIGTERM'), before);
    assert.deepEqual(fs.readdirSync(root), []);
});
