// Groups 1–4 against installed servers in an actual VS Code extension host.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const vscode = require('vscode');
const { inventory } = require('./publication-host-run');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
    const run = process.env.LANGUAGE_GROUPS_RUN, root = path.join(run, 'workspace');
    const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
    const baseline = JSON.parse(await fs.readFile(path.join(run, 'baseline.json'), 'utf8'));
    const evidence = { vscode: vscode.version, date: new Date().toISOString(), checks: [], requests: [], diagnostics: [], processes: [],
        limitations: ['Navigation uses real VS Code provider commands, not rendered peek/go-to UI; signature UI additionally uses real CDP typing with a warm server.',
            'Malicious resolve payloads, stale responses and forbidden snippet transforms require controlled headless tests.'] };
    const checkpoint = () => fs.writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
    const children = [], traces = [], originals = new Map();
    for (const method of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
        const original = cp[method]; originals.set(method, original);
        cp[method] = function (command, args, options) {
            const stack = new Error().stack || '';
                        if (!stack.includes(path.join(run, 'extension/out/main.js')) && !stack.includes(path.join(run, 'extension/src/'))) { return original.apply(this, arguments); }
            const config = [...Object.values(launch.servers), launch.controlledCss].find(server => server.command === command);
            assert.ok(method === 'spawn' && config, 'Only configured direct servers may launch');
            assert.deepEqual(args, config.args); assert.equal(options?.shell, false);
            const child = original.apply(this, arguments);
            children.push(child); evidence.processes.push({ command, args, pid: child.pid });
            const trace = { command, pid: child.pid, stdin: '', stdout: '', stderr: '', truncated: false };
            traces.push(trace);
            const capture = (stream, data) => {
                if (Buffer.byteLength(trace[stream]) + Buffer.byteLength(data) > 8 * 1024 * 1024) { trace.truncated = true; }
                else { trace[stream] += data.toString(); }
            };
            for (const stream of ['stdout', 'stderr']) { child[stream]?.on('data', chunk => capture(stream, chunk)); }
            const write = child.stdin.write;
            child.stdin.write = function (chunk) { capture('stdin', chunk); return write.apply(this, arguments); };
            return child;
        };
    }
    async function check(name, action) {
        const start = Date.now();
        try { await action(); evidence.checks.push({ name, ok: true, elapsedMs: Date.now() - start }); }
        catch (error) { evidence.checks.push({ name, ok: false, error: error.stack, elapsedMs: Date.now() - start }); console.error('GROUPS_FAIL', name, error); }
        await checkpoint();
    }
    function pos(doc, needle, within = needle.length) {
        const offset = doc.getText().indexOf(needle);
        assert.notEqual(offset, -1, needle); assert.equal(doc.getText().indexOf(needle, offset + 1), -1, 'Unique anchor: ' + needle);
        return doc.positionAt(offset + within);
    }
    async function settle() {
        let previous = await inventory(root), stable = 0;
        for (let i = 0; i < 40; i++) {
            await delay(250); const next = await inventory(root);
            stable = JSON.stringify(next) === JSON.stringify(previous) ? stable + 1 : 0;
            if (stable >= 4) { return next; } previous = next;
        }
        assert.fail('Edit generation failed to settle in 10 seconds');
    }
    async function query(command, doc, cursor, ...args) {
        const before = await settle(), text = doc.getText(), version = doc.version;
        const entry = { command, file: path.basename(doc.uri.fsPath), cursor }; evidence.requests.push(entry);
        try {
            const result = await vscode.commands.executeCommand(command, doc.uri, cursor, ...args);
            entry.result = result; return result;
        } finally {
            await delay(250); assert.deepEqual(await inventory(root), before, 'Language requests are disk read-only');
            assert.equal(doc.getText(), text); assert.equal(doc.version, version); entry.readOnly = true; await checkpoint();
        }
    }
    async function replace(doc, needle, replacement) {
        const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(pos(doc, needle, 0), pos(doc, needle)), replacement);
        assert.equal(await vscode.workspace.applyEdit(edit), true); await settle();
    }
    function diagnostics(doc) {
        return vscode.languages.getDiagnostics(doc.uri).map(d => ({ message: d.message, code: d.code, severity: d.severity,
            range: d.range, sourceText: doc.getText(d.range), source: d.source }));
    }
    async function waitDiagnostics(doc, name, predicate) {
        const start = Date.now(); let items;
        do { items = diagnostics(doc); if (predicate(items)) { evidence.diagnostics.push({ name, elapsedMs: Date.now() - start, items }); return items; } await delay(100); }
        while (Date.now() - start < 20000);
        evidence.diagnostics.push({ name, items }); assert.fail('Diagnostics condition timed out: ' + name + ': ' + JSON.stringify(items));
    }
    const isTypeError = d => Number(d.code) === 2322 && /not assignable/.test(d.message);
    function safeMarkdown(value) {
        if (value instanceof vscode.MarkdownString) { assert.notEqual(value.isTrusted, true); assert.ok(!value.isTrusted?.enabledCommands?.length); assert.notEqual(value.supportHtml, true); }
    }
    const events = vscode.languages.onDidChangeDiagnostics(event => {
        evidence.diagnostics.push({ event: Date.now(), uris: event.uris.map(uri => uri.toString()) });
    });
    try {
        assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
        const extension = vscode.extensions.getExtension('jesterking.literate');
        assert.equal(extension.extensionPath, path.join(run, 'extension')); await extension.activate();
        const doc = await vscode.workspace.openTextDocument(path.join(root, 'index.literate'));
        assert.equal(doc.languageId, 'markdown');
        const original = doc.getText();
        await check('Background TS7 diagnostics on open, without hover or any provider request', async () => {
            const items = await waitDiagnostics(doc, 'cold open', ds => ds.some(isTypeError));
            const item = items.find(isTypeError); assert.equal(item.sourceText, 'broken');
            assert.equal(item.range.start.line, pos(doc, 'const broken:', 6).line);
            assert.deepEqual(await inventory(root), baseline, 'Background diagnostics must not materialize projections');
            assert.equal(evidence.requests.length, 0);
            assert.ok(traces.every(t => !/textDocument\/(hover|completion|signatureHelp|definition)/.test(t.stdin)));
        });
        await check('Fix clears background error without a language query', async () => {
            assert.ok(diagnostics(doc).some(isTypeError), 'An observed error is required before claiming it cleared');
                        await replace(doc, 'const broken: number = "wrong";', 'const broken: number = 9;');
            await waitDiagnostics(doc, 'fixed', ds => !ds.some(isTypeError));
            await delay(1000); assert.ok(!diagnostics(doc).some(isTypeError));
        });
        await check('Reintroduced background error moves with unsaved source lines and retains while idle', async () => {
            await replace(doc, 'const broken: number = 9;', '// inserted line one\n// inserted line two\nconst broken: number = "wrong";');
            const expected = pos(doc, 'const broken:', 6);
            await waitDiagnostics(doc, 'shifted', ds => ds.some(d => isTypeError(d) && d.range.start.line === expected.line && d.sourceText === 'broken'));
            await delay(2000);
            assert.ok(diagnostics(doc).some(d => isTypeError(d) && d.range.start.line === expected.line), 'Diagnostic remains without requests or cursor movement');
            assert.equal(evidence.requests.length, 0);
        });
        await check('Physical multiline template unsaved shift preserves original diagnostic source mapping', async () => {
            const template = await vscode.workspace.openTextDocument(path.join(root, 'wrapper.template'));
            await replace(template, '// Header one', '// New wrapper line\n// Header one');
            await waitDiagnostics(doc, 'template shift', ds => ds.some(d => isTypeError(d) && d.range.start.line === pos(doc, 'const broken:', 6).line && d.sourceText === 'broken'));
        });
        await check('Signature help maps through wrapper and fragment, active second argument', async () => {
            const result = await query('vscode.executeSignatureHelpProvider', doc, pos(doc, 'greet("Ada", '));
            assert.ok(result?.signatures.length); assert.equal(result.activeParameter, 1);
            const signature = result.signatures[result.activeSignature]; assert.match(signature.label, /greet.*name.*string.*count.*number/);
            assert.equal(signature.parameters.length, 2); safeMarkdown(signature.documentation);
            for (const parameter of signature.parameters) { safeMarkdown(parameter.documentation); }
        });
        await check('TS7 completion resolve returns documentation and keeps mapped edit safe', async () => {
            const cursor = pos(doc, 'members.doc');
            const result = await query('vscode.executeCompletionItemProvider', doc, cursor, undefined, 100);
            const item = result?.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'documentedMember');
            assert.ok(item); assert.equal(item.command, undefined); assert.ok(!item.additionalTextEdits?.length);
            const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
            assert.ok(range?.contains(cursor)); assert.equal(doc.getText(range), 'doc');
            assert.equal(item.insertText, 'documentedMember'); safeMarkdown(item.documentation);
            assert.match(typeof item.documentation === 'string' ? item.documentation : item.documentation?.value || '', /Documented member/);
            assert.ok(traces.some(t => t.command === launch.servers.typescript.command && t.stdin.includes('completionItem/resolve')), 'Real resolve request observed');
        });
        async function locations(command, needle, within, expected) {
            const result = await query(command, doc, pos(doc, needle, within));
            assert.ok(result?.length, 'Expected navigation targets');
            const normalized = [];
            for (const location of result) {
                const uri = location.uri || location.targetUri, range = location.range || location.targetSelectionRange;
                assert.equal(uri.scheme, 'file'); assert.ok(uri.fsPath.startsWith(root + path.sep));
                assert.ok(!['main.ts', 'overlay.ts'].includes(path.basename(uri.fsPath)), 'Generated target must map to source');
                const target = await vscode.workspace.openTextDocument(uri);
                normalized.push({ file: path.basename(uri.fsPath), text: target.getText(range), range });
            }
            evidence.requests[evidence.requests.length - 1].targets = normalized;
            for (const [file, text] of expected) { assert.ok(normalized.some(item => item.file === file && item.text === text), JSON.stringify(normalized)); }
        }
        for (const [name, command, needle, within, expected] of [
            ['local definition', 'vscode.executeDefinitionProvider', 'greet("Ada", 2)', 2, [['index.literate', 'greet']]],
            ['physical definition', 'vscode.executeDefinitionProvider', 'const physicalUse = physical;', 23, [['physical.ts', 'physical']]],
            ['overlay definition', 'vscode.executeDefinitionProvider', 'const overlayUse = overlay;', 21, [['dependency.literate', 'overlay']]],
            ['type definition', 'vscode.executeTypeDefinitionProvider', 'const size = shape.size;', 15, [['index.literate', 'Shape']]],
            ['implementation', 'vscode.executeImplementationProvider', 'interface Shape', 12, [['index.literate', 'Square']]],
            ['references', 'vscode.executeReferenceProvider', 'function greet', 11, [['index.literate', 'greet']]]
        ]) { await check(name + ' maps to real source', () => locations(command, needle, within, expected)); }
        await check('References include declaration and call as distinct mapped source ranges', async () => {
            const result = await query('vscode.executeReferenceProvider', doc, pos(doc, 'function greet', 11));
            assert.ok(result?.some(l => l.uri.toString() === doc.uri.toString() && l.range.start.line === pos(doc, 'function greet').line));
            assert.ok(result?.some(l => l.uri.toString() === doc.uri.toString() && l.range.start.line === pos(doc, 'greet("Ada", 2)').line));
        });
        await check('Mason CSS command-bearing property items in an itemDefaults list are rejected, not executed', async () => {
                    const source = await vscode.workspace.openTextDocument(path.join(root, 'style.literate'));
                    const result = await query('vscode.executeCompletionItemProvider', source, pos(source, '    dis'));
                    assert.ok(!result?.items.some(item => item.label === 'display'));
                    const trace = traces.find(t => t.command === launch.servers.css.command);
                    assert.ok(trace?.stdout.includes('editor.action.triggerSuggest'), 'Server really returned command-bearing completions');
                                assert.ok(trace.stdout.includes('itemDefaults'), 'Server really returned list defaults');
                });
                for (const [file, needle, wanted] of [['style.literate', '    color: rg', 'rgb'], ['page.literate', '<div cl', 'class']]) {
            await check(file + ' real Mason snippet completion and mapped snippet insertion', async () => {
                const source = await vscode.workspace.openTextDocument(path.join(root, file));
                const editor = await vscode.window.showTextDocument(source);
                const cursor = pos(source, needle);
                const result = await query('vscode.executeCompletionItemProvider', source, cursor, undefined, 100);
                const item = result?.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === wanted);
                assert.ok(item, 'Missing ' + wanted); assert.ok(item.insertText instanceof vscode.SnippetString, 'Real server snippet survives safe subset validation');
                assert.equal(item.command, undefined); assert.ok(!item.additionalTextEdits?.length); safeMarkdown(item.documentation);
                const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
                assert.ok(range?.contains(cursor)); assert.equal(range.start.line, cursor.line); assert.equal(range.end.line, cursor.line);
                const before = source.getText(), prefix = before.slice(0, source.offsetAt(range.start)), suffix = before.slice(source.offsetAt(range.end));
                assert.equal(await editor.insertSnippet(item.insertText, range), true);
                const after = source.getText(); assert.notEqual(after, before); assert.ok(after.startsWith(prefix)); assert.ok(after.endsWith(suffix));
                const inserted = after.slice(prefix.length, after.length - suffix.length);
                assert.ok(inserted.includes(wanted)); assert.ok(!/\$\{|\$\d/.test(inserted), 'No literal snippet placeholders');
                                if (wanted === 'class') {
                                    assert.equal(inserted, 'class=""');
                                    assert.equal(source.offsetAt(editor.selection.active), prefix.length + 'class="'.length, 'Caret is inside the live first tabstop');
                                }
                evidence.requests[evidence.requests.length - 1].snippetAcceptance = { raw: item.insertText.value, inserted, source: after, selection: editor.selection };
                await settle();
            });
        }
        await check('Real typing opens signature UI on ( and selects second parameter on comma', async () => {
                    await require('./language-signature-ui').signatureUI(launch.port, doc, evidence);
                    await settle();
                });
        await require('./language-actions-host').actionsHost({ root, launch, evidence, traces,
            check, query, pos, replace, settle, waitDiagnostics });
        await check('Prose/headers and all physical fixtures remain unchanged; only normal edit outputs allowed', async () => {
            const markup = text => text.split('\n').filter(line => line.startsWith('```') || line.startsWith('#') || line.startsWith('Prose') || /^<<.*>>$/.test(line));
            assert.deepEqual(markup(doc.getText()), markup(original));
            const after = await settle(); evidence.finalInventory = after;
            for (const [name, entry] of Object.entries(baseline)) { assert.deepEqual(after[name], entry, name); }
            const allowed = ['main.ts', 'overlay.ts', 'style.css', 'generated-page.html', 'page.html', 'index.html', 'dependency.html', 'style.html'];
            for (const name of Object.keys(after).filter(name => !(name in baseline))) { assert.ok(allowed.includes(name), 'Unexpected edit output: ' + name); }
            for (const name of ['typescript', 'css', 'html']) { assert.ok(evidence.processes.some(p => p.command === launch.servers[name].command)); }
        });
    } catch (error) { evidence.fatal = error.stack; }
    finally {
        events.dispose(); for (const [method, original] of originals) { cp[method] = original; }
        for (const child of children) { child.kill('SIGTERM'); }
        await fs.writeFile(path.join(run, 'server-traces.json'), JSON.stringify(traces, null, 2));
        evidence.ok = !evidence.fatal && evidence.checks.every(c => c.ok); await checkpoint();
    }
    assert.equal(evidence.ok, true, 'See ' + path.join(run, 'evidence.json'));
    console.log('LANGUAGE_GROUPS_PASS', JSON.stringify(evidence.checks));
};
