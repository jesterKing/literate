// Real workbench UI checks: never invoke completion/hover providers or triggerSuggest.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const puppeteer = require('puppeteer-core');
const { inventory } = require('./publication-host-run');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
    const run = process.env.LANGUAGE_AUTO_HOST_RUN;
    const root = path.join(run, 'workspace');
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
    const launch = JSON.parse(await fs.readFile(path.join(run, 'launch.json'), 'utf8'));
    const baseline = JSON.parse(await fs.readFile(path.join(run, 'baseline.json'), 'utf8'));
    const evidence = { vscode: vscode.version, date: new Date().toISOString(), checks: [], observations: [],
        input: 'CDP real character/Escape/Enter/ArrowLeft key events',
        manualLanguageRequests: false, screenshots: false };
    const checkpoint = () => fs.writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
    let browser, page, document, ordinary, original;
    const childProcess = require('node:child_process');
    const spawn = childProcess.spawn;
    evidence.processes = []; evidence.events = [];
    const traces = [];
    childProcess.spawn = function (command, args, options) {
        const child = spawn.apply(this, arguments);
        if (command === launch.command) {
            const record = { command, args, pid: child.pid, time: Date.now(), stdout: '', stderr: '' };
            evidence.processes.push({ command, args, pid: child.pid, time: record.time });
            traces.push(record);
            for (const stream of ['stdout', 'stderr']) {
                child[stream]?.on('data', chunk => { if (record[stream].length < 1024 * 1024) { record[stream] += chunk.toString(); } });
            }
        }
        return child;
    };
    const subscriptions = [
        vscode.window.onDidChangeWindowState(state => evidence.events.push({ type: 'windowFocus', time: Date.now(), focused: state.focused })),
        vscode.workspace.onDidChangeConfiguration(() => evidence.events.push({ type: 'configuration', time: Date.now() })),
        vscode.workspace.onDidOpenTextDocument(doc => evidence.events.push({ type: 'open', time: Date.now(), file: path.basename(doc.uri.fsPath) })),
        vscode.window.onDidChangeActiveTextEditor(editor => evidence.events.push({ type: 'activeEditor', time: Date.now(), file: editor && path.basename(editor.document.uri.fsPath) })),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.fsPath.startsWith(root)) {
                evidence.events.push({ type: 'edit', time: Date.now(), file: path.basename(event.document.uri.fsPath),
                    changes: event.contentChanges.map(c => ({ text: c.text.slice(0, 80), rangeOffset: c.rangeOffset, rangeLength: c.rangeLength })),
                    selection: vscode.window.activeTextEditor?.selection.active });
            }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => evidence.events.push({ type: 'selection', time: Date.now(),
            file: path.basename(event.textEditor.document.uri.fsPath), kind: event.kind, selection: event.selections[0].active }))
    ];
    async function widget() {
        return page.evaluate(() => {
            const visible = element => {
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const widgets = [...window.document.querySelectorAll('.suggest-widget')].filter(visible);
            return { visible: widgets.length > 0,
                labels: widgets.flatMap(w => [...w.querySelectorAll('.monaco-list-row .label-name')].filter(visible).map(e => e.textContent)),
                text: widgets.map(w => w.innerText),
                focused: window.document.hasFocus(), activeElement: window.document.activeElement?.outerHTML.slice(0, 500) };
        });
    }
    async function observe(name) {
        const state = await widget();
        evidence.observations.push({ name, time: Date.now(), state });
        return state;
    }
    async function check(name, action) {
        const started = Date.now();
        try { await action(); evidence.checks.push({ name, ok: true, elapsedMs: Date.now() - started }); }
        catch (error) {
            evidence.checks.push({ name, ok: false, error: error.stack, elapsedMs: Date.now() - started });
            if (page) { await observe(name + ':failure'); }
            console.error('AUTO_UI_FAIL', name, error);
        }
        await checkpoint();
    }
    async function waitList(name) {
        const started = Date.now();
        let state;
        do {
            state = await widget();
            assert.equal(vscode.window.state.focused, true, 'Host window lost focus while waiting for suggestions');
            if (state.visible && state.labels.includes('list')) {
                evidence.observations.push({ name, elapsedMs: Date.now() - started, state });
                return;
            }
            await delay(75);
        } while (Date.now() - started < 25000);
        evidence.observations.push({ name, state });
        assert.fail('Rendered suggestion widget containing list did not appear: ' + JSON.stringify(state));
    }
    async function quiet(name, duration = 1800, requireWindowFocus = true) {
        const started = Date.now();
        let samples = 0, unfocusedSamples = 0;
        do {
            const state = await widget(); samples++;
            const focused = vscode.window.state.focused && state.focused;
            if (!focused) { unfocusedSamples++; }
            if (requireWindowFocus) { assert.equal(focused, true, name + ': host window lost focus'); }
            assert.equal(state.visible, false, name + ': unexpected UI ' + JSON.stringify(state));
            await delay(50);
        } while (Date.now() - started < duration);
        evidence.observations.push({ name, quietMs: Date.now() - started, samples, requireWindowFocus, unfocusedSamples });
    }
    // Recover only between cases, never while observing a pending completion/cancellation.
    async function focusEditor(doc) {
        const started = Date.now();
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        do {
            await page.bringToFront();
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            await delay(100);
            const focused = () => page.evaluate(() => window.document.hasFocus()
                && !!window.document.activeElement?.closest('.monaco-editor'));
            if (vscode.window.state.focused && await focused()) {
                await delay(100);
                if (vscode.window.state.focused && await focused()) {
                    assert.equal(vscode.window.activeTextEditor, editor);
                    evidence.observations.push({ name: 'case setup focus', file: path.basename(doc.uri.fsPath), elapsedMs: Date.now() - started });
                    return editor;
                }
            }
        } while (Date.now() - started < 5000);
        assert.fail('Could not focus the host editor during case setup: ' + JSON.stringify(await widget()));
    }
    async function at(doc, needle) {
        const editor = await focusEditor(doc);
        const offset = doc.getText().indexOf(needle);
        assert.notEqual(offset, -1, needle);
        const position = doc.positionAt(offset + needle.length);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        await delay(150);
        assert.equal(vscode.window.activeTextEditor, editor);
        assert.equal(vscode.window.state.focused, true);
        assert.equal((await widget()).focused, true);
        return editor;
    }
    async function type(text) {
        const doc = vscode.window.activeTextEditor.document;
        const version = doc.version;
        await page.keyboard.type(text);
        for (let attempt = 0; attempt < 100 && doc.version === version; attempt++) { await delay(5); }
        assert.ok(doc.version > version, 'real keyboard input reached the document');
    }
    async function reset(doc = document) {
        const editor = await focusEditor(doc);
        await page.keyboard.press('Escape');
        if (doc.getText() !== original) {
            assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original)), true);
        }
        await delay(600);
        await page.keyboard.press('Escape');
    }
    try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${launch.port}`, defaultViewport: null });
        for (let attempt = 0; attempt < 60 && !page; attempt++) {
            for (const candidate of await browser.pages()) {
                if (await candidate.evaluate(() => !!window.document.querySelector('.monaco-workbench'))) { page = candidate; break; }
            }
            if (!page) { await delay(100); }
        }
        assert.ok(page, 'VS Code renderer CDP target');
        await page.bringToFront();
        const extension = vscode.extensions.getExtension('jesterking.literate');
        assert.equal(extension.extensionPath, launch.extension || path.resolve(__dirname, '../../..'));
        await extension.activate();
        document = await vscode.workspace.openTextDocument(path.join(root, 'index.literate'));
        ordinary = await vscode.workspace.openTextDocument(path.join(root, 'ordinary.md'));
        original = document.getText();
        assert.equal(document.languageId, 'markdown');
        assert.equal(ordinary.languageId, 'markdown');
        await at(document, '        this');
        // Let startup configuration/editor events settle without issuing any language request.
        await delay(2000);
        await focusEditor(document);
        const config = vscode.workspace.getConfiguration('editor', document);
        assert.deepEqual(config.get('quickSuggestions'), { other: 'off', comments: 'off', strings: 'off' });
        assert.equal(config.get('suggestOnTriggerCharacters'), false);
        assert.equal(vscode.workspace.getConfiguration('literate', document).get('automaticCompletion'), true);
        evidence.effectiveSettings = { quickSuggestions: config.get('quickSuggestions'), suggestOnTriggerCharacters: false, automaticCompletion: true };
        await check('Opening fixtures is read-only before cold first typing', async () => {
            assert.deepEqual(await inventory(root), baseline);
            assert.equal(evidence.processes.length, 0, 'first typing starts a cold server; no hover/prewarm');
            await quiet('initial editor', 300);
        });
        await check('Cold constructor this. opens list UI, filters li, Enter inserts only this.list', async () => {
            const insertion = document.getText().indexOf('        this') + '        this'.length;
            await type('.');
            await waitList('cold this.');
            await type('l'); await type('i');
            await waitList('continued this.li');
            assert.equal(document.getText(), original.slice(0, insertion) + '.li' + original.slice(insertion));
            await page.keyboard.press('Enter');
            await delay(500);
            assert.equal(document.getText(), original.slice(0, insertion) + '.list' + original.slice(insertion), 'accept changes only the mapped code span, never prose/header');
            await quiet('accepted widget', 300);
            evidence.acceptedSource = document.getText();
        });
        await reset();
        await check('Method this. also opens list UI', async () => {
            await at(document, '    inspect() {\n        this');
            await type('.'); await waitList('method this.');
            await page.keyboard.press('Escape');
            await quiet('Escape dismisses visible suggestions');
        });
        const negatives = [
            ['prose', document, 'Prose sentinel this', '.'],
            ['fence header', document, '```ts', '.'],
            ['fragment tag', document, '// <<ta', 'g'],
            ['ordinary Markdown code', ordinary, '        this', '.']
        ];
        for (const [name, doc, needle, character] of negatives) {
            await reset(doc);
            await check(name + ' stays quiet', async () => {
                await at(doc, needle); await type(character); await quiet(name);
            });
        }
        for (const cancellation of ['cursor move', 'editor focus move', 'Escape pending']) {
            await reset();
            await check(cancellation + ' cancels automatic suggestions', async () => {
                await at(document, '        this');
                const started = Date.now();
                await type('.');
                if (cancellation === 'cursor move') { await page.keyboard.press('ArrowLeft'); }
                else if (cancellation === 'editor focus move') { await vscode.window.showTextDocument(ordinary, { preview: false }); }
                else { await page.keyboard.press('Escape'); }
                const cancelMs = Date.now() - started;
                evidence.observations.push({ name: cancellation, cancelMs });
                assert.ok(cancelMs < 200, 'cancellation must beat the 200ms debounce');
                if (cancellation === 'editor focus move') {
                    assert.equal(vscode.window.activeTextEditor.document, ordinary, 'focus actually moved away from the edited document');
                }
                await quiet(cancellation, 2500, cancellation !== 'editor focus move');
            });
        }
        await reset();
        await check('Resource opt-out false stays quiet', async () => {
            await vscode.workspace.getConfiguration('literate', document).update('automaticCompletion', false, vscode.ConfigurationTarget.Global);
            await at(document, '        this');
            assert.equal(vscode.workspace.getConfiguration('literate', document).get('automaticCompletion'), false);
            await type('.'); await quiet('automaticCompletion false', 2500);
        });
        await reset(); await reset(ordinary);
        await check('No unrelated fixture writes; only normal auto-generation outputs allowed', async () => {
            const after = await inventory(root);
            evidence.finalInventory = after;
            for (const [name, entry] of Object.entries(baseline)) { assert.deepEqual(after[name], entry, 'physical fixture changed: ' + name); }
            const generated = Object.keys(after).filter(name => !(name in baseline));
            evidence.generatedByNormalEditing = generated;
            for (const name of generated) { assert.ok(['main.ts', 'index.html'].includes(name), 'unexpected generated file: ' + name); }
            assert.equal(document.getText(), original);
            assert.equal(ordinary.getText(), original);
        });
    } catch (error) {
        evidence.fatal = error.stack;
        throw error;
    } finally {
        childProcess.spawn = spawn;
        subscriptions.forEach(subscription => subscription.dispose());
        await fs.writeFile(path.join(run, 'server-traces.json'), JSON.stringify(traces, null, 2));
        await checkpoint();
        if (browser) { await browser.disconnect(); }
    }
    assert.equal(evidence.checks.filter(check => !check.ok).length, 0, 'See evidence.json for UI failures');
    console.log('LANGUAGE_AUTO_HOST_PASS', vscode.version, JSON.stringify(evidence.checks));
};
