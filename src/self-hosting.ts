import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { SourceDocument, GeneratedFile } from './engine';

export interface SelfHostingResult {
    ok: boolean;
    checks: { name: string; ok: boolean; message?: string }[];
}

export async function verifySelfHosting(
    root: string, documents: SourceDocument[], templates: Record<string, string>, files: GeneratedFile[],
    options: { timeoutMs?: number } = {}
): Promise<SelfHostingResult> {
    const checks: SelfHostingResult['checks'] = [];
    let stage = 'layout';
    let temporary: string | undefined;
    const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
    try {
        root = path.resolve(root);
        const overlay = new Map<string, string>();
        const directories = new Set<string>();
        for (const file of files) {
            const absolute = path.resolve(root, file.path);
            const relative = path.relative(root, absolute);
            if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                throw new Error(`Output outside project: ${file.path}`);
            }
            if (overlay.has(absolute)) { throw new Error(`Duplicate output: ${file.path}`); }
            overlay.set(absolute, file.content);
            for (let directory = path.dirname(absolute); directory !== root; directory = path.dirname(directory)) {
                directories.add(directory);
            }
        }
        for (const required of ['src/engine.ts', 'src/cli.ts']) {
            if (!overlay.has(path.join(root, required))) { throw new Error(`Missing generated ${required}`); }
        }
        const timeout = options.timeoutMs ?? 10000;
        if (!Number.isFinite(timeout) || timeout <= 0) { throw new Error('timeoutMs must be positive and finite'); }
        checks.push({ name: stage, ok: true });
        stage = 'typecheck';
        const ts: typeof import('typescript') = require('typescript');
        const readFile = (name: string): string | undefined => overlay.get(path.resolve(name)) ?? ts.sys.readFile(name);
        const fileExists = (name: string): boolean => overlay.has(path.resolve(name)) || ts.sys.fileExists(name);
        const directoryExists = (name: string): boolean => directories.has(path.resolve(name)) || ts.sys.directoryExists(name);
        const format = (diagnostic: import('typescript').Diagnostic): string => {
            let location = '';
            if (diagnostic.file && diagnostic.start !== undefined) {
                const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                location = `${path.relative(root, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}: `;
            }
            return `${location}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
        };
        const configPath = path.join(root, 'tsconfig.json');
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        if (config.error) { throw new Error(format(config.error)); }
        const generatedSources = [...overlay.keys()].filter(name => /\.[cm]?[jt]sx?$/.test(name));
        const parsed = ts.parseJsonConfigFileContent(config.config, {
            ...ts.sys, readFile, fileExists,
            readDirectory: (directory, extensions, excludes, includes, depth) => [...new Set([
                ...ts.sys.readDirectory(directory, extensions, excludes, includes, depth),
                ...generatedSources.filter(name => name.startsWith(path.resolve(directory) + path.sep)
                    && (!extensions || extensions.some(extension => name.endsWith(extension))))
            ])]
        }, root, { noEmit: true, incremental: false, composite: false }, configPath);
        if (parsed.errors.length) { throw new Error(parsed.errors.map(format).join('\n')); }
        const host = ts.createCompilerHost(parsed.options);
        host.readFile = readFile;
        host.fileExists = fileExists;
        host.directoryExists = directoryExists;
        host.getSourceFile = (name, languageVersion, onError) => {
            const text = readFile(name);
            if (text === undefined) { if (onError) { onError(`Cannot read ${name}`); } return undefined; }
            return ts.createSourceFile(name, text, languageVersion, true);
        };
        const program = ts.createProgram([...new Set([...parsed.fileNames, ...generatedSources])], parsed.options, host);
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.length) { throw new Error(diagnostics.map(format).join('\n')); }
        checks.push({ name: stage, ok: true });
        stage = 'bundle';
        const esbuild: typeof import('esbuild') = require('esbuild');
        const bundle = await esbuild.build({
            absWorkingDir: root, entryPoints: [path.join(root, 'src/engine.ts')],
            bundle: true, platform: 'node', format: 'cjs', write: false,
            tsconfig: configPath, logLevel: 'silent',
            plugins: [{ name: 'fresh-generated', setup(build) {
                build.onResolve({ filter: /.*/ }, args => {
                    if (!path.isAbsolute(args.path) && !args.path.startsWith('.')) { return undefined; }
                    const base = path.resolve(args.resolveDir || root, args.path);
                    const extensions = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];
                    const candidates = [base, ...extensions.map(extension => base + extension)];
                    if (/\.jsx?$/.test(base)) {
                        candidates.push(base.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx'));
                        if (base.endsWith('.js')) { candidates.push(base.slice(0, -3) + '.tsx'); }
                    }
                    const exists = (candidate: string): boolean => overlay.has(candidate) || ts.sys.fileExists(candidate);
                    const file = candidates.find(exists);
                    if (file) { return { path: file }; }
                    if (exists(path.join(base, 'package.json'))) { return undefined; }
                    const index = extensions.map(extension => path.join(base, 'index' + extension)).find(exists);
                    return index ? { path: index } : undefined;
                });
                build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
                    const contents = overlay.get(args.path);
                    if (contents === undefined) { return undefined; }
                    const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.jsx') ? 'jsx'
                        : /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js';
                    return { contents, loader, resolveDir: path.dirname(args.path) };
                });
            } }]
        });
        if (!bundle.outputFiles || bundle.outputFiles.length !== 1) { throw new Error('Expected one engine bundle'); }
        checks.push({ name: stage, ok: true });
        stage = 'fixedpoint';
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'literate-self-host-'));
        await fs.writeFile(path.join(temporary, 'engine.cjs'), bundle.outputFiles[0].contents);
        await fs.writeFile(path.join(temporary, 'runner.cjs'), [
            "const fs = require('fs');",
            "const { generateProject } = require('./engine.cjs');",
            "const { documents, templates } = JSON.parse(fs.readFileSync(0, 'utf8'));",
            'Promise.resolve().then(() => generateProject(documents, templates)).then(result => {',
            'process.stdout.write(JSON.stringify(result));',
            '}).catch(error => { console.error(error); process.exitCode = 1; });'
        ].join('\n'));
        const stdout = await new Promise<string>((resolve, reject) => {
            const child = execFile(process.execPath, [path.join(temporary!, 'runner.cjs')], {
                cwd: temporary, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'
            }, (error, output, stderr) => {
                if (error) { reject(new Error(error.killed ? `Engine child timed out or was killed (${timeout} ms limit)`
                    : `Engine child failed: ${stderr.trim() || error.message}`)); }
                else { resolve(output); }
            });
            child.stdin!.on('error', () => { /* execFile reports early child exits. */ });
            child.stdin!.end(JSON.stringify({ documents, templates }));
        });
        const regenerated = JSON.parse(stdout);
        if (!regenerated || !Array.isArray(regenerated.files) || !Array.isArray(regenerated.diagnostics)) {
            throw new Error('Invalid engine result: expected files and diagnostics arrays');
        }
        if (regenerated.diagnostics.length) {
            throw new Error(`Regenerated engine diagnostics: ${JSON.stringify(regenerated.diagnostics)}`);
        }
        const actual = new Map<string, string>();
        for (const file of regenerated.files) {
            if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || actual.has(file.path)) {
                throw new Error('Invalid or duplicate regenerated output');
            }
            actual.set(file.path, file.content);
        }
        for (const file of files) {
            if (!actual.has(file.path)) { throw new Error(`Missing regenerated output: ${file.path}`); }
            if (actual.get(file.path) !== file.content) { throw new Error(`Regenerated content mismatch: ${file.path}`); }
            actual.delete(file.path);
        }
        if (actual.size) { throw new Error(`Unexpected regenerated output: ${[...actual.keys()].sort()[0]}`); }
        checks.push({ name: stage, ok: true });
    } catch (error) {
        checks.push({ name: stage, ok: false, message: message(error) });
    } finally {
        if (temporary) {
            try { await fs.rm(temporary, { recursive: true, force: true }); }
            catch (error) { checks.push({ name: 'cleanup', ok: false, message: message(error) }); }
        }
    }
    return { ok: checks.every(check => check.ok), checks };
}
