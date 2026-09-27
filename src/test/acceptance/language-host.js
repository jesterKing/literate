// Real installed-host acceptance. Only the isolated launcher may invoke this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const vscode = require('vscode');
const { inventory } = require('./publication-host-run');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const label = item => typeof item.label === 'string' ? item.label : item.label.label;
const projected = ['main.ts', 'overlay.ts', 'main.zig'];
// Exact outputs of this fixture, never source files, physical dependencies or config.
const generatedOutputs = [...projected, 'index.html', 'dependency.html'];
exports.run = async () => {
    const run = process.env.LANGUAGE_HOST_RUN;
    assert.ok(run && path.basename(run).startsWith('language-host-'), 'Use language-host-run.js');
    assert.equal(path.dirname(run), path.resolve(__dirname, '../../../out'));
    const root = path.join(run, 'workspace');
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
    const baseline = JSON.parse(await fs.readFile(path.join(run, 'baseline.json'), 'utf8'));
    const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
    const evidence = { date: new Date().toISOString(), vscode: vscode.version, checks: [], requests: [], edits: [], processes: [],
        limitations: ['Real servers only: malicious protocol payload rejection belongs to headless tests.',
                    'VS Code built-in background processes are outside the production launch guard; built-in Markdown snippets are recorded but never accepted.',
            'No completion commands, snippets, additional edits, tasks, saves, preview or generation commands are executed.'] };
    const checkpoint = () => fs.writeFile(path.join(run, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    async function check(name, operation) {
        try { await operation(); evidence.checks.push({ name, ok: true }); }
        catch (error) { evidence.checks.push({ name, ok: false, failure: error.stack || String(error) }); }
        await checkpoint();
    }
    const originals = new Map();
    const children = [];
    // Guard production launches, not independent VS Code built-in extension hosts.
    // Servers' own compiler subprocesses are outside this extension-host guard.
    for (const method of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
        const original = childProcess[method]; originals.set(method, original);
        childProcess[method] = function (command, args, options) {
            const stack = new Error().stack || '';
                        if (!stack.includes(path.resolve(__dirname, '../../../out/main.js'))) {
                            return original.apply(this, arguments);
                        }
                        const record = { method, command, args, shell: options?.shell };
            evidence.processes.push(record);
            const configured = Object.values(launch.servers).find(server => server.command === command);
            assert.ok(method === 'spawn' && configured, `Unexpected runtime/script launch: ${method} ${command}`);
            assert.deepEqual(args, configured.args);
            assert.equal(options?.shell, false);
            const child = original.apply(this, arguments);
            children.push(child);
            record.pid = child.pid;
            child.once('close', (code, signal) => { record.code = code; record.signal = signal; });
            return child;
        };
    }
    const documents = [];
    const originalsText = new Map();
    function position(document, needle, within = needle.length) {
        const offset = document.getText().indexOf(needle);
        assert.ok(offset >= 0, `Missing cursor anchor ${needle}`);
        assert.equal(document.getText().indexOf(needle, offset + 1), -1, `Ambiguous cursor anchor ${needle}`);
        return document.positionAt(offset + within);
    }
    async function request(kind, document, cursor) {
        assert.equal(document.languageId, 'markdown');
        assert.ok(document.uri.fsPath.endsWith('.literate'));
        const before = await inventory(root);
        assert.deepEqual(before, baseline, 'Query batch must start with no generated outputs and unchanged source/dependency files');
        const text = document.getText(), version = document.version;
        const record = { kind, source: path.basename(document.uri.fsPath), position: cursor, before };
        evidence.requests.push(record);
        try {
            const result = await vscode.commands.executeCommand(kind === 'completion'
                ? 'vscode.executeCompletionItemProvider' : 'vscode.executeHoverProvider', document.uri, cursor);
            if (kind === 'completion') {
                record.items = (result?.items || []).map(item => ({ label: label(item), detail: item.detail, insertText: item.insertText, range: item.range, command: item.command }));
                for (const item of result?.items || []) {
                    // executeCompletionItemProvider also returns VS Code's built-in snippets,
                    // even with editor.snippetSuggestions=none. Never accept or execute them.
                    if (item.command?.command === '_snippet.markAsUsed'
                        && item.command.arguments?.[0]?.extensionId?.value === 'vscode.markdown') {
                        (record.ignoredBuiltinSnippets ||= []).push(label(item));
                        continue;
                    }
                    assert.equal(item.command, undefined, 'No completion commands accepted');
                    assert.ok(!(item.insertText instanceof vscode.SnippetString), 'No executable snippets accepted');
                    assert.ok(!item.additionalTextEdits?.length, 'No additional edits accepted');
                }
            } else {
                record.hovers = result;
                for (const hover of result || []) {
                    for (const content of hover.contents) {
                        if (content instanceof vscode.MarkdownString) {
                            assert.notEqual(content.isTrusted, true);
                            assert.ok(!content.isTrusted || !content.isTrusted.enabledCommands?.length);
                            assert.notEqual(content.supportHtml, true);
                        }
                    }
                    if (hover.range) { assert.ok(hover.range.contains(cursor), 'Hover range maps to source cursor'); }
                }
            }
            return result;
        } finally {
            await delay(250);
            record.after = await inventory(root);
            record.readOnly = JSON.stringify(record.before) === JSON.stringify(record.after);
            await checkpoint();
            assert.deepEqual(record.after, before, 'Provider request must not create or modify workspace files');
            assert.deepEqual(record.after, baseline, 'Requests must leave projected outputs absent and source/dependency disk files unchanged');
            assert.equal(document.getText(), text, 'Provider must not edit source');
            assert.equal(document.version, version);
        }
    }
    async function complete(document, needle, expected) {
        const cursor = position(document, needle, needle.endsWith(';') ? needle.length - 1 : needle.length);
        const result = await request('completion', document, cursor);
        const item = result?.items.find(item => label(item) === expected);
        assert.ok(item, `Expected ${expected}; got ${(result?.items || []).map(label).join(', ')}`);
        assert.equal(item.command, undefined);
        assert.equal(typeof item.insertText, 'string');
        assert.ok(!item.additionalTextEdits?.length);
        return { item, cursor };
    }
    async function hover(document, needle, expected) {
        const result = await request('hover', document, position(document, needle, needle.length - 2));
        const text = (result || []).flatMap(item => item.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
        assert.match(text, expected, `Expected meaningful type hover for ${needle}`);
    }
    async function settledInventory(phase, ready = () => true) {
        let previous = await inventory(root), stable = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
            await delay(250);
            const next = await inventory(root);
            stable = ready(next) && JSON.stringify(next) === JSON.stringify(previous) ? stable + 1 : 0;
            if (stable >= 4) { return next; }
            previous = next;
        }
        assert.fail(`${phase} did not settle within 10 seconds`);
    }
    async function edit(document, range, text, reason) {
        const before = await inventory(root), source = document.getText();
        const start = document.offsetAt(range.start), end = document.offsetAt(range.end);
        const operation = new vscode.WorkspaceEdit(); operation.replace(document.uri, range, text);
        assert.equal(await vscode.workspace.applyEdit(operation), true);
        assert.equal(document.getText(), source.slice(0, start) + text + source.slice(end), 'Only requested source span changed');
        assert.equal(document.isDirty, true);
        // Normal edit listeners generate files. Observe that independently, then
        // restore the no-output fixture before any language-service query runs.
        const after = await settledInventory('Edit-triggered generation', snapshot => generatedOutputs.every(name => snapshot[name]));
        const record = { reason, before, after,
            generatedOnEdit: generatedOutputs.filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name])) };
        evidence.edits.push(record);
        await checkpoint();
        for (const name of Object.keys(baseline)) { assert.deepEqual(after[name], baseline[name], `${name} must not change on disk after source edits`); }
        for (const name of generatedOutputs) {
            assert.equal(baseline[name], undefined, `Refusing to clean original fixture file ${name}`);
            assert.ok((await fs.lstat(path.join(root, name))).isFile(), `Refusing to clean non-file output ${name}`);
        }
        record.cleanup = { removed: [], before: after };
        for (const name of generatedOutputs) {
            await fs.unlink(path.join(root, name));
            record.cleanup.removed.push(name);
        }
        // Never repeatedly delete outputs to hide a pending generation/request write.
        record.cleanup.after = await settledInventory('Generated-output fixture cleanup');
        await checkpoint();
        assert.deepEqual(record.cleanup.after, baseline, 'Cleanup must restore no outputs without modifying source/dependencies');
    }
    function replace(document, needle, text, reason) {
        const start = position(document, needle, 0), end = position(document, needle);
        return edit(document, new vscode.Range(start, end), text, reason);
    }
    try {
        const extension = vscode.extensions.getExtension('jesterking.literate');
        assert.ok(extension);
        assert.equal(extension.extensionPath, path.resolve(__dirname, '../../..'));
        await extension.activate(); assert.equal(extension.isActive, true);
        for (const name of ['index.literate', 'dependency.literate']) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, name)));
            assert.equal(document.languageId, 'markdown'); documents.push(document); originalsText.set(document, document.getText());
        }
        const [document, dependency] = documents;
        await check('Activation/open is read-only; all projections absent', async () => {
            assert.deepEqual(await inventory(root), baseline);
            for (const name of projected) { assert.equal(baseline[name], undefined); }
        });
        let localCompletion;
        for (const [needle, expected] of [['local.loc;', 'localMember'], ['physical.phy;', 'physicalMember'], ['aliased.ali;', 'aliasMember'], ['overlay.ove;', 'overlayMember'], ['dep.dep;', 'dependencyValue']]) {
            await check(`Completion ${expected} on Markdown`, async () => {
                const result = needle === 'dep.dep;'
                    ? await request('completion', document, position(document, needle, needle.length - 1))
                    : undefined;
                if (result) { assert.ok(result.items.some(item => label(item) === expected)); }
                else if (needle === 'dep.dep;') { assert.fail('No Zig completion result'); }
                else { const value = await complete(document, needle, expected); if (expected === 'localMember') { localCompletion = value; } }
            });
        }
        for (const [needle, type] of [['local.localMember', /localMember.*string|localMember[\s\S]*string/], ['physical.physicalMember', /number/], ['aliased.aliasMember', /boolean/], ['overlay.overlayMember', /string/], ['dep.dependencyValue', /u32/]]) {
            await check(`Typed hover ${needle} on Markdown`, () => hover(document, needle, type));
        }
        await check('Fragment completion inside << tag remains', async () => {
            const result = await request('completion', document, position(document, 'Tag completion stays available: <<body', 'Tag completion stays available: <<bo'.length));
            assert.ok(result?.items.some(item => label(item) === 'body'));
        });
        await check('Apply returned simple completion only to mapped source span', async () => {
            assert.ok(localCompletion, 'Local completion prerequisite failed');
            const { item, cursor } = localCompletion;
            const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
            assert.ok(range instanceof vscode.Range && range.contains(cursor));
            assert.equal(range.start.line, cursor.line); assert.equal(range.end.line, cursor.line);
            assert.equal(document.getText(range), 'loc');
            assert.equal(typeof item.insertText, 'string'); assert.equal(item.insertText, 'localMember');
            await edit(document, range, item.insertText, 'returned completion applied to Markdown only');
            assert.ok(document.getText().includes('local.localMember;'));
        });
        await check('Unsaved local edit changes subsequent hover type', async () => {
            await replace(document, 'localMember: "local"', 'localMember: 17', 'unsaved local type change');
            await hover(document, 'const localHover = local.localMember', /number/);
        });
        await check('Unsaved imported generated dependency overlay changes hover type', async () => {
            await replace(dependency, 'overlayMember: "overlay"', 'overlayMember: false', 'unsaved imported generated dependency');
            await hover(document, 'overlay.overlayMember', /boolean/);
            await complete(document, 'overlay.ove;', 'overlayMember');
        });
        await check('Headers, prose, fragment references and physical dependencies unchanged', async () => {
            const markup = text => text.split('\n').filter(line => line.startsWith('```') || line.startsWith('#') || line.startsWith('Prose') || line.startsWith('Never') || line.startsWith('Tag completion') || /^<<.*>>$/.test(line));
            for (const doc of documents) { assert.deepEqual(markup(doc.getText()), markup(originalsText.get(doc))); }
            const after = await inventory(root);
            for (const name of Object.keys(baseline)) { assert.deepEqual(after[name], baseline[name], `${name} remains byte/mtime identical`); }
        });
        await check('Normal edit-triggered generation observed; only generated fixture outputs cleaned', async () => {
            assert.equal(evidence.edits.length, 3);
            for (const edit of evidence.edits) {
                assert.deepEqual(edit.generatedOnEdit, generatedOutputs);
                assert.deepEqual(edit.cleanup?.removed, generatedOutputs);
                assert.deepEqual(edit.cleanup.after, baseline);
            }
        });
        await check('Language queries leave projected outputs absent and source/dependency disk files unchanged', async () => {
            const snapshots = [await inventory(root), ...evidence.requests.flatMap(item => [item.before, item.after])];
            for (const snapshot of snapshots) { assert.deepEqual(snapshot, baseline); }
        });
        await check('Only configured direct language servers launched; no runtime/scripts', async () => {
            assert.ok(evidence.processes.some(item => item.command === launch.servers.typescript.command));
            assert.ok(evidence.processes.some(item => item.command === launch.servers.zig.command));
            assert.ok(evidence.processes.every(item => item.method === 'spawn' && Object.values(launch.servers).some(server => server.command === item.command)));
        });
    } catch (error) { evidence.checks.push({ name: 'Host setup/execution', ok: false, failure: error.stack || String(error) }); }
    finally {
        for (const [method, original] of originals) { childProcess[method] = original; }
        for (const child of children) { child.kill('SIGTERM'); }
        evidence.ok = evidence.checks.every(check => check.ok);
        await checkpoint();
        await fs.writeFile(path.join(run, 'report.md'), '# Installed VS Code language acceptance\n\n'
            + `VS Code ${vscode.version}; ${evidence.ok ? 'PASS' : 'FAIL'}. See acceptance.json for raw provider results and separate request/edit inventories.\n\n`
            + evidence.checks.map(check => `- ${check.ok ? 'PASS' : 'FAIL'}: ${check.name}${check.ok ? '' : '\n\n```text\n' + check.failure + '\n```\n'}`).join('\n')
            + '\n\nNormal existing generation on content edits is observed separately from language requests; edits are not expected to be read-only.\n'
            + evidence.edits.map(edit => `\n- ${edit.reason}: generated ${edit.generatedOnEdit.join(', ')}; fixture cleanup removed ${edit.cleanup?.removed.join(', ') || '(not completed)'}.`).join('')
            + '\n\nAfter each edit, generation must settle before one-time cleanup of the exact generated output allowlist. Sources, physical dependencies and config are never cleaned or saved. Each query starts and ends at the unchanged no-output disk baseline, including queries using dirty imported overlays.\n'
            + '\nNo production changes or generation commands. Separate edit, cleanup and request inventories are retained in acceptance.json.\n');
    }
    assert.equal(evidence.ok, true, `Acceptance findings: ${path.join(run, 'report.md')}`);
};
