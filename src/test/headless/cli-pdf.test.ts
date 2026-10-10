/* eslint-disable @typescript-eslint/naming-convention -- Font manifest family names. */
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createTransactionIO, run } from '../../cli';
import { LatexConverter } from '../../publication-latex';
import { PdfCompiler, PdfCompilationError } from '../../publication-pdf';
import type { DiagramRenderer } from '../../publication-mermaid';

const pdf = Buffer.from('%PDF-1.4\ncompiled book');
const png = Buffer.from('89504e470d0a1a0a00ff80', 'hex');
const source = '# Book\n\n```text: <<main.*>>= generated.txt $\nhello\n```\n';
const convert: LatexConverter = async () => 'Converted body';
const compile: PdfCompiler = async () => ({ pdf, warnings: [] });
const diagrams: DiagramRenderer = async assets => new Map(assets.map(asset => [asset.source, {
    pdf: Buffer.from('%PDF-1.4\ndiagram'), svg: Buffer.from('<svg></svg>')
}]));
function write(root: string, name: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
}
function fixture(t: { after(callback: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literate pdf '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'index.literate', source);
    return root;
}
function tree(root: string): unknown {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name), stat = fs.lstatSync(file);
        return [name, stat.mode, stat.isDirectory() ? tree(file)
            : [stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('hex')]];
    });
}
interface Response {
    command: string; ok: boolean; errors: string[]; diagnostics: { message: string }[];
    outputs: { path: string; status: string }[]; usage?: string;
    publication?: { warnings: string[]; buildDirectory?: string };
    elapsedMs?: number;
}
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalListeners = () => signals.map(signal => process.rawListeners(signal));
async function command(args: string[], compiler = compile, converter = convert,
    factory = createTransactionIO, json = true) {
    const listeners = signalListeners();
    let stdout = '', stderr = '';
    const code = await run([...args, ...(json ? ['--json'] : [])], {
        stdout: value => { stdout += value; }, stderr: value => { stderr += value; }
    }, factory, converter, diagrams, compiler);
    assert.deepEqual(signalListeners(), listeners, 'CLI signal handlers must be disposed on every exit');
    const response: Response = json ? JSON.parse(stdout) : undefined;
    if (json) {
        assert.equal(stderr, ''); assert.equal(response.ok, code === 0);
        if (response.command === 'latex' || response.command === 'pdf') {
            assert.equal(typeof response.elapsedMs, 'number'); assert.ok(response.elapsedMs! >= 0);
        }
    }
    return { code, response, stdout, stderr };
}
const args = (root: string, output = 'books/result.pdf') => ['pdf', root, '--output', output];

for (const flags of [[], ['--output'], ['--output', ''], ['--output', 'book.tex'],
    ['--output', 'book.PDF'], ['--output', '../book.pdf'], ['--output', '/book.pdf'],
    ['--output=book.pdf'], ['--output', 'a.pdf', '--output', 'b.pdf'],
    ['--output', 'a.pdf', '--keep-build', '--keep-build'], ['--output', 'a.pdf', '--keep-build=true'],
    ['--output', 'a.pdf', '--keep-build', 'true'], ['--output', 'a.pdf', '--paper', 'a3'],
    ['--output', 'a.pdf', '--margin', '4mm'], ['--output', 'a.pdf', '--margin-top', 'NaNmm'],
    ['--output', 'a.pdf', '--margin-left', '20mm', '--margin-left', '21mm'],
    ['--output', 'a.pdf', '--font-manifest', '../fonts.json'], ['--output', 'a.pdf', '--browser', 'relative'],
    ['--help', '--output', 'book.tex']]) {
    test(`pdf rejects invalid arguments: ${JSON.stringify(flags)}`, async t => {
        const root = fixture(t), before = tree(root);
        const result = await command(['pdf', path.join(root, 'absent'), ...flags],
            async () => assert.fail('compiler called'), async () => assert.fail('converter called'));
        assert.equal(result.code, 2);
        assert.deepEqual(result.response.outputs, []);
        assert.deepEqual(tree(root), before);
    });
}
for (const name of ['latex', 'generate', 'check', 'inspect', 'self-check']) {
    test(`${name} rejects PDF-only keep-build even with help`, async () => {
        for (const help of [[], ['--help']]) {
            assert.equal((await command([name, '--keep-build', ...help])).code, 2);
        }
    });
}
for (const help of [['pdf', '--help'], ['help', 'pdf'], ['pdf', '-h', '--keep-build']]) {
    test(`pdf help: ${help.join(' ')}`, async () => {
        const result = await command(help, async () => assert.fail('compiler called'));
        assert.equal(result.code, 0);
        assert.match(result.response.usage!, /--output path\.pdf/);
        for (const flag of ['--paper', '--margin', '--font-manifest', '--browser', '--keep-build']) {
            assert.ok(result.response.usage!.includes(flag));
        }
    });
}

test('series PDF publishes every manifest book with geometry and cross-book links', async t => {
    const root = fixture(t), series = path.join(root, 'series');
    fs.mkdirSync(series);
    write(root, 'books/python/index.literate', '# Python\n\n[Zig](../zig/index.literate#zig)\n');
    write(root, 'books/zig/index.literate', '# Zig\n\n[Python](../python/index.literate#python)\n');
    write(series, 'literate-workspace.json', JSON.stringify({ schemaVersion: 1, publications: [
        { id: 'python', title: 'Python', root: '../books/python', entry: 'index.literate',
            pdf: '../publications/python.pdf', paper: 'a4',
            margins: { top: 20, outer: 50, bottom: 20, inner: 20 } },
        { id: 'zig', title: 'Zig', root: '../books/zig', entry: 'index.literate',
            pdf: '../publications/zig.pdf', paper: 'legal',
            margins: { top: 10, outer: 30, bottom: 15, inner: 25 } }
    ] }));
    const links: string[] = [], geometries: string[] = [];
    const converter: LatexConverter = async document => {
        links.push(JSON.stringify(document));
        return 'Converted body';
    };
    const compiler: PdfCompiler = async files => {
        const tex = String(files.find(file => file.path.endsWith('/book.tex'))!.content);
        geometries.push(tex);
        return { pdf: Buffer.from(`pdf-${geometries.length}`), warnings: [] };
    };
    const result = await command(['pdf', series], compiler, converter);
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.deepEqual(result.response.outputs, [
        { path: '../publications/python.pdf', status: 'written' },
        { path: '../publications/zig.pdf', status: 'written' }
    ]);
    assert.match(links[0], /zig\.pdf#h-/);
    assert.match(links[1], /python\.pdf#h-/);
    assert.match(geometries[0], /a4paper,top=20mm,outer=50mm,bottom=20mm,inner=20mm/);
    assert.match(geometries[1], /legalpaper,top=10mm,outer=30mm,bottom=15mm,inner=25mm/);
    assert.equal(fs.readFileSync(path.join(root, 'publications/python.pdf'), 'utf8'), 'pdf-1');
    assert.equal(fs.readFileSync(path.join(root, 'publications/zig.pdf'), 'utf8'), 'pdf-2');
});

test('series PDF requires every destination before conversion', async t => {
    const root = fixture(t), series = path.join(root, 'series');
    fs.mkdirSync(series);
    write(root, 'books/one/index.literate', '# One\n');
    write(series, 'literate-workspace.json', JSON.stringify({ schemaVersion: 1, publications: [
        { id: 'one', root: '../books/one' }
    ] }));
    const result = await command(['pdf', series], async () => assert.fail('compiler called'),
        async () => assert.fail('converter called'));
    assert.equal(result.code, 1);
    assert.match(result.response.errors.join(' '), /requires pdf/);
    assert.deepEqual(result.response.outputs, []);
});

test('PDF compiler receives the full virtual plan; only PDF is published, with metadata and stable identical output', async t => {
    const root = fixture(t);
    write(root, 'index.literate', source + '\n![Image](image.png)\n\n```mermaid\ngraph TD; A-->B\n```\n'
        + '\n```SETTINGS\nfont-body=Example\nfont-heading=Example\nfont-code=Example\nfont-fragment=Example\n```\n');
    write(root, 'image.png', png);
    write(root, 'font.ttf', Buffer.from([0, 255, 128, 1])); write(root, 'license.txt', 'license');
    write(root, 'fonts.json', JSON.stringify({ version: 1, families: { Example: {
        regular: 'font.ttf', bold: 'font.ttf', italic: 'font.ttf', boldItalic: 'font.ttf', licenses: ['license.txt']
    } } }));
    write(root, 'browser', 'trusted browser');
    // A virtual entry must not be checked as a real project destination, even an input alias.
    fs.mkdirSync(path.join(root, 'books'));
    fs.linkSync(path.join(root, 'index.literate'), path.join(root, 'books/book.tex'));
    const original = tree(root);
    const compiler: PdfCompiler = async (files, entry, options) => {
        assert.equal(entry, 'books/book.tex'); assert.equal(options?.keepBuild, true);
                assert.equal(typeof options?.checkCancelled, 'function'); options?.checkCancelled?.();
        assert.deepEqual(tree(root), original, 'nothing is staged before compilation');
        const tex = files.find(file => file.path === entry)!.content;
        assert.equal(typeof tex, 'string');
        assert.match(String(tex), /a5paper,top=18mm,right=16mm,bottom=22mm,left=20mm/);
        assert.ok(String(tex).includes('Converted body'));
        for (const bytes of [png, Buffer.from([0, 255, 128, 1]), Buffer.from('license'),
            Buffer.from('%PDF-1.4\ndiagram'), Buffer.from('<svg></svg>')]) {
            assert.ok(files.some(file => (typeof file.content === 'string'
                            ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content)).equals(bytes)), bytes.toString());
        }
        assert.equal(files.length, 9, 'entry, four font faces, license, image, diagram PDF and SVG');
        assert.ok(files.every(file => file.path.startsWith('books/')));
        return { pdf, warnings: ['Missing glyph'], buildDirectory: '/private/retained' };
    };
    const flags = [...args(root), '--keep-build', '--paper', 'a5', '--margin', '22mm',
        '--margin-top', '18mm', '--margin-left', '20mm', '--margin-right', '16mm',
        '--font-manifest', 'fonts.json', '--browser', path.join(root, 'browser')];
    const result = await command(flags, compiler);
    assert.equal(result.code, 0, JSON.stringify(result.response));
    assert.deepEqual(result.response.outputs, [{ path: 'books/result.pdf', status: 'written' }]);
    assert.deepEqual(result.response.publication, { warnings: ['Missing glyph'], buildDirectory: '/private/retained' });
    assert.deepEqual(fs.readdirSync(path.join(root, 'books')).sort(), ['book.tex', 'result.pdf']);
    assert.deepEqual(fs.readFileSync(path.join(root, 'books/result.pdf')), pdf);
    assert.equal(fs.existsSync(path.join(root, 'generated.txt')), false);
    fs.utimesSync(path.join(root, 'books/result.pdf'), new Date('2001-01-01'), new Date('2001-01-01'));
    const before = tree(root);
    const repeated = await command(flags);
    assert.equal(repeated.code, 0);
    assert.deepEqual(repeated.response.outputs, [{ path: 'books/result.pdf', status: 'current' }]);
    assert.deepEqual(tree(root), before);
});

for (const failure of ['converter', 'compiler']) {
    test(`${failure} failure leaves output intact and reports retained compilation details`, async t => {
        const root = fixture(t); write(root, 'books/result.pdf', 'old PDF');
        const before = tree(root);
        const result = await command([...args(root), '--keep-build'], async () => {
            if (failure === 'converter') { assert.fail('compiler called'); }
            throw new PdfCompilationError('TeX failed', '/private/failed', ['Font warning']);
        }, failure === 'converter' ? async () => { throw new Error('Pandoc failed'); } : convert);
        assert.equal(result.code, 1); assert.deepEqual(result.response.outputs, []);
        if (failure === 'compiler') {
            assert.deepEqual(result.response.publication, { warnings: ['Font warning'], buildDirectory: '/private/failed' });
        }
        assert.deepEqual(tree(root), before);
    });
}

test('latex never invokes the PDF compiler or adds publication metadata', async t => {
    const root = fixture(t);
    const result = await command(['latex', root, '--output', 'book.tex'],
        async () => assert.fail('PDF compilation must be explicit'));
    assert.equal(result.code, 0);
    assert.equal(result.response.publication, undefined);
    assert.deepEqual(result.response.outputs, [{ path: 'book.tex', status: 'written' }]);
    assert.equal(fs.existsSync(path.join(root, 'generated.txt')), false);
});

test('human warnings and retained directories go to stderr; keep-build defaults false', async t => {
    const root = fixture(t);
    const result = await command(args(root), async (_files, _entry, options) => {
        assert.equal(options?.keepBuild, false);
                assert.equal(typeof options?.checkCancelled, 'function'); options?.checkCancelled?.();
        return { pdf, warnings: ['Font warning'], buildDirectory: '/private/build' };
    }, convert, createTransactionIO, false);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /warning: Font warning/);
    assert.match(result.stderr, /build directory: \/private\/build/);
    assert.doesNotMatch(result.stdout, /Font warning/);
    assert.match(result.stdout, /literate: finished in (?:\d+ ms|\d{2,}:\d{2})\n$/);
});

for (const input of ['index.literate', 'image.pdf', 'template.pdf', 'fonts.json', 'font.ttf', 'license.txt', 'browser']) {
    test(`final PDF cannot hard-link input ${input}`, async t => {
        const root = fixture(t);
        write(root, 'index.literate', source + '\n![Image](image.pdf)\n\n```mermaid\ngraph TD; A-->B\n```\n'
            + '\n```text: <<other.*>>= other.txt $ template=template.pdf\ntext\n```\n'
            + '\n```SETTINGS\nfont-body=Example\nfont-heading=Example\nfont-code=Example\nfont-fragment=Example\n```\n');
        write(root, 'image.pdf', pdf); write(root, 'template.pdf', 'template');
        write(root, 'font.ttf', 'font'); write(root, 'license.txt', 'license'); write(root, 'browser', 'browser');
        write(root, 'selected.ttf', 'selected font'); write(root, 'selected-license.txt', 'selected license');
        write(root, 'fonts.json', JSON.stringify({ version: 1, families: {
            Example: { regular: 'selected.ttf', bold: 'selected.ttf', italic: 'selected.ttf',
                boldItalic: 'selected.ttf', licenses: ['selected-license.txt'] },
            Unselected: { regular: 'font.ttf', bold: 'font.ttf', italic: 'font.ttf',
                boldItalic: 'font.ttf', licenses: ['license.txt'] }
        } }));
        fs.linkSync(path.join(root, input), path.join(root, 'result.pdf'));
        const before = tree(root);
        const result = await command([...args(root, 'result.pdf'), '--font-manifest', 'fonts.json',
            '--browser', path.join(root, 'browser')], async () => assert.fail('compiler called'),
        async () => assert.fail('converter called'));
        assert.equal(result.code, 1); assert.match(result.response.errors.join('\n'), /aliases input/);
        assert.deepEqual(tree(root), before);
    });
}
for (const output of ['image.pdf', 'IMAGE.pdf', 'template.pdf', 'missing.pdf', 'index.literate/book.pdf']) {
    test(`final PDF protects lexical input destination ${output}`, async t => {
        const root = fixture(t);
        write(root, 'index.literate', source + '\n![Image](image.pdf)\n'
            + '\n```text: <<other.*>>= other.txt $ template=template.pdf\ntext\n```\n'
            + '\n```text: <<missing.*>>= missing.txt $ template=missing.pdf\ntext\n```\n');
        write(root, 'image.pdf', pdf); write(root, 'template.pdf', 'template');
        const before = tree(root);
        const result = await command(args(root, output), async () => assert.fail('compiler called'));
        assert.equal(result.code, 1); assert.match(result.response.errors.join('\n'), /conflicts with input/);
        assert.deepEqual(tree(root), before);
    });
}
for (const alias of ['symlink', 'browser-target']) {
    test(`final PDF protects ${alias}`, async t => {
        const root = fixture(t);
        write(root, 'result.pdf', 'old PDF');
        if (alias === 'symlink') {
            fs.unlinkSync(path.join(root, 'result.pdf'));
            fs.symlinkSync(path.join(root, 'index.literate'), path.join(root, 'result.pdf'));
        } else {
            fs.appendFileSync(path.join(root, 'index.literate'), '\n```mermaid\ngraph TD; A-->B\n```\n');
            fs.symlinkSync(path.join(root, 'result.pdf'), path.join(root, 'browser'));
        }
        const before = tree(root);
        const result = await command([...args(root, 'result.pdf'), '--browser', path.join(root, 'browser')],
            async () => assert.fail('compiler called'));
        assert.equal(result.code, 1);
        assert.match(result.response.errors.join('\n'), /Symbolic link|conflicts with browser input/);
        assert.deepEqual(tree(root), before);
    });
}
for (const signal of signals) {
    for (const phase of ['root-read', 'conversion', 'compilation'] as const) {
        test(`${signal} during ${phase} cancels PDF publication without losing compiler progress`, async t => {
            const root = fixture(t);
            write(root, 'books/result.pdf', 'old PDF');
            const before = tree(root), listeners = signalListeners();
            const interrupt = (): void => {
                signals.forEach((name, index) => {
                    assert.equal(process.listenerCount(name), listeners[index].length + 1);
                });
                assert.equal(process.emit(signal), true);
            };
            let compiled = false, converted = false;
            const pending = command([...args(root), '--keep-build'], async () => {
                compiled = true;
                assert.equal(phase, 'compilation');
                interrupt();
                return { pdf, warnings: ['Compiler progress'], buildDirectory: '/private/cancelled' };
            }, async () => {
                converted = true;
                if (phase === 'conversion') { interrupt(); }
                return 'Converted body';
            }, () => assert.fail('cancelled PDF must not enter the transaction'));
            if (phase === 'root-read') { interrupt(); }
            const result = await pending;
            assert.equal(result.code, 1);
            assert.match(result.response.errors.join('\n'), new RegExp(`cancelled by ${signal}`));
            assert.equal(converted, phase !== 'root-read');
            assert.equal(compiled, phase === 'compilation');
            assert.deepEqual(result.response.outputs, []);
            if (compiled) {
                assert.deepEqual(result.response.publication, {
                    warnings: ['Compiler progress'], buildDirectory: '/private/cancelled'
                });
            }
            assert.deepEqual(tree(root), before);
        });
    }
}

test('compiler cancellation failure retains its warnings and build directory', async t => {
    const root = fixture(t), before = tree(root);
    const result = await command([...args(root), '--keep-build'], async () => {
        process.emit('SIGTERM');
        throw new PdfCompilationError('Compiler cancelled', '/private/interrupted', ['Partial build warning']);
    });
    assert.equal(result.code, 1);
    assert.match(result.response.errors.join('\n'), /Compiler cancelled/);
    assert.deepEqual(result.response.publication, {
        warnings: ['Partial build warning'], buildDirectory: '/private/interrupted'
    });
    assert.deepEqual(tree(root), before);
});

for (const phase of ['preflight', 'prepare', 'install'] as const) {
    for (const existing of [false, true]) {
        test(`PDF cancellation during ${phase} restores outputs (existing=${existing})`, async t => {
            const root = fixture(t);
            if (existing) { write(root, 'books/result.pdf', 'old PDF'); }
            const before = tree(root), listeners = signalListeners();
            let interrupted = false, repeated = 0;
            const interrupt = (): void => {
                interrupted = true;
                assert.equal(process.emit('SIGINT'), true);
            };
            const repeatDuringRollback = (): void => {
                if (!interrupted) { return; }
                repeated++;
                signals.forEach((signal, index) => {
                    assert.equal(process.listenerCount(signal), listeners[index].length + 1);
                    assert.equal(process.emit(signal), true);
                });
            };
            const result = await command([...args(root), '--keep-build'], async () => ({
                pdf, warnings: ['Build complete'], buildDirectory: '/private/transaction'
            }), convert, directory => {
                const io = createTransactionIO(directory);
                return { ...io,
                    async inspect(value) {
                        const kind = await io.inspect(value);
                        if (phase === 'preflight' && !interrupted) { interrupt(); }
                        return kind;
                    },
                    async writeNew(value, content) {
                        await io.writeNew(value, content);
                        if (phase === 'prepare' && value.endsWith('.stage')) { interrupt(); }
                    },
                    async rename(from, to) {
                        await io.rename(from, to);
                        if (phase === 'install' && from.endsWith('.stage') && to === 'books/result.pdf') {
                            interrupt();
                        } else if (interrupted) { repeatDuringRollback(); }
                    },
                    async removeFile(value) {
                        repeatDuringRollback();
                        await io.removeFile(value);
                    },
                    async removeDirectory(value) {
                        repeatDuringRollback();
                        await io.removeDirectory(value);
                    }
                };
            });
            assert.equal(interrupted, true);
            assert.equal(result.code, 1);
            assert.match(result.response.errors.join('\n'), /cancelled by SIGINT/);
            if (phase !== 'preflight') {
                assert.match(result.response.errors.join('\n'), /rolled_back/);
                assert.ok(repeated > 0, 'rollback and cleanup must retain handlers for repeated signals');
            }
            assert.ok(result.response.outputs.every(output => output.status !== 'written'));
            assert.deepEqual(result.response.publication, {
                warnings: ['Build complete'], buildDirectory: '/private/transaction'
            });
            assert.deepEqual(tree(root), before);
        });
    }
}

for (const cleanupFails of [false, true]) {
    test(`postcommit signals preserve committed PDF status (cleanupFails=${cleanupFails})`, async t => {
        const root = fixture(t), listeners = signalListeners();
        write(root, 'books/result.pdf', 'old PDF');
        let interrupted = false;
        const result = await command([...args(root), '--keep-build'], async () => ({
            pdf, warnings: ['Build complete'], buildDirectory: '/private/committed'
        }), convert, directory => {
            const io = createTransactionIO(directory);
            return { ...io, async removeFile(value) {
                if (value.endsWith('.backup')) {
                    interrupted = true;
                    signals.forEach((signal, index) => {
                        assert.equal(process.listenerCount(signal), listeners[index].length + 1);
                        assert.equal(process.emit(signal), true);
                    });
                    if (cleanupFails) { throw new Error('backup cleanup failed'); }
                }
                await io.removeFile(value);
            } };
        });
        assert.equal(interrupted, true);
        assert.equal(result.code, cleanupFails ? 1 : 0);
        assert.deepEqual(result.response.outputs, [{ path: 'books/result.pdf', status: 'written' }]);
        assert.deepEqual(fs.readFileSync(path.join(root, 'books/result.pdf')), pdf);
        assert.deepEqual(result.response.publication, {
            warnings: ['Build complete'], buildDirectory: '/private/committed'
        });
        assert.doesNotMatch(result.response.errors.join('\n'), /cancelled|rolled_back/);
        if (cleanupFails) {
            assert.match(result.response.errors.join('\n'), /committed, cleanup failed/);
            assert.match(result.response.errors.join('\n'), /backup cleanup failed/);
        } else {
            assert.deepEqual(result.response.errors, []);
            assert.deepEqual(fs.readdirSync(path.join(root, 'books')), ['result.pdf']);
        }
    });
}

for (const existing of [false, true]) {
    test(`PDF install rolls back after rename (existing=${existing})`, async t => {
        const root = fixture(t);
        if (existing) { write(root, 'books/result.pdf', 'old PDF'); }
        const before = tree(root);
        let injected = false;
        const result = await command(args(root), compile, convert, directory => {
            const io = createTransactionIO(directory);
            return { ...io, async rename(from, to) {
                await io.rename(from, to);
                if (!injected && from.endsWith('.stage') && to === 'books/result.pdf') {
                    injected = true; throw new Error('failure after PDF install');
                }
            } };
        });
        assert.equal(injected, true); assert.equal(result.code, 1);
        assert.match(result.response.errors.join('\n'), /rolled_back/);
        assert.ok(result.response.outputs.every(output => output.status !== 'written'));
        assert.deepEqual(tree(root), before);
    });
}
