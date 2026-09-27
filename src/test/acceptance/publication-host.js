// Ordinary, opt-in installed-extension-host acceptance; not generated from the book.
// Launch with publication-host-run.js (private profile/workspace; existing binaries only).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const { inventory } = require('./publication-host-run');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl), pending = new Map();
    let id = 0;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = error => { clearTimeout(timer); reject(error); };
    });
    socket.onmessage = event => {
        const value = JSON.parse(event.data), entry = pending.get(value.id);
        if (entry) {
            pending.delete(value.id); clearTimeout(entry.timer);
            value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result);
        }
    };
    return { close: () => socket.close(), send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const next = ++id;
            const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 5000);
            pending.set(next, { resolve, reject, timer });
            socket.send(JSON.stringify({ id: next, method, params, sessionId }));
        });
    } };
}
async function key(client, session, key, code, modifiers = 0) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }, session);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, session);
}
async function drivePrompt(client, session, stage, cancel, evidence) {
    let state;
    for (let attempt = 0; attempt < 80; attempt++) {
        const result = await client.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
            const widget = document.querySelector('.quick-input-widget');
            const input = widget?.querySelector('input');
            if (!widget || !input || widget.getBoundingClientRect().height === 0) return null;
            return { placeholder: input.placeholder, text: widget.textContent, focused: document.activeElement === input };
        })()` }, session);
        assert.equal(result.exceptionDetails, undefined);
        state = result.result?.value;
        const expected = stage === 'folder' ? 'Select publication project folder'
            : stage === 'paper' ? 'Publication page size' : 'Margins in mm';
        if (state?.focused && (state.placeholder.includes(expected) || state.text.includes(expected))) { break; }
        state = null;
        await delay(100);
    }
    assert.ok(state, `Native ${stage} prompt not visible/focused`);
    if (!cancel && stage === 'paper') {
        await client.send('Input.insertText', { text: 'a5' }, session);
        await delay(150);
    }
    if (!cancel && stage === 'margins') {
        await key(client, session, 'a', 65, 2);
        await client.send('Input.insertText', { text: '15,16,17,18' }, session);
    }
    await key(client, session, cancel ? 'Escape' : 'Enter', cancel ? 27 : 13);
    evidence.push({ stage, modality: 'real workbench prompt; CDP keyboard input', key: cancel ? 'Escape' : 'Enter',
        focused: state.focused, placeholder: state.placeholder });
}

exports.run = async () => {
    const run = process.env.M5_HOST_RUN;
    assert.ok(run && path.basename(run).startsWith('m5-host-'), 'Use the isolated launcher');
    assert.equal(path.dirname(run), path.resolve(__dirname, '../../../out'));
    const root = path.join(run, 'workspace');
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
    const evidence = { date: new Date().toISOString(), version: vscode.version, checks: [], prompts: [], helpers: [],
        modality: { activation: 'real out/main.js', commands: 'vscode.commands.executeCommand',
            quickPickAndInput: 'native workbench UI driven by CDP', saveDialog: 'instrumented API response, not native dialog',
            notifications: 'captured API calls', progress: 'real VS Code API', helper: 'observed, unmodified external process',
            physicalKeyboard: false, screenReader: false } };
    const originals = new Map();
    function replace(object, name, value) {
        const original = object[name];
        originals.set(name, () => { object[name] = original; });
        object[name] = value;
        assert.equal(object[name], value, `${name} must be instrumentable in this host`);
        return original;
    }
    let client, session, plan, queuePromise, queueComplete = false, queueCloseObserved = false;
    const errors = [], notifications = [];
    try {
        client = await connect(Number(process.env.M5_CDP_PORT));
        const targets = await client.send('Target.getTargets');
        const target = targets.targetInfos.find(target => target.type === 'page' && target.url.includes('workbench'));
        assert.ok(target, 'Real workbench target');
        session = (await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        const quickPick = replace(vscode.window, 'showQuickPick', async (items, options) => {
            const stage = options?.placeHolder === 'Select publication project folder' ? 'folder' : 'paper';
            assert.ok(plan, `Unexpected ${stage} prompt`);
            plan.seen.push(stage);
            const response = quickPick.call(vscode.window, items, options);
            const [value] = await Promise.all([response, drivePrompt(client, session, stage, plan.cancel === stage, evidence.prompts)]);
            if (plan.cancel === stage) { assert.equal(value, undefined); }
            else if (stage === 'paper') { assert.equal(value, 'a5'); }
            return value;
        });
        const input = replace(vscode.window, 'showInputBox', async options => {
            assert.ok(plan); plan.seen.push('margins');
            const response = input.call(vscode.window, options);
            const [value] = await Promise.all([response, drivePrompt(client, session, 'margins', plan.cancel === 'margins', evidence.prompts)]);
            assert.equal(value, plan.cancel === 'margins' ? undefined : '15,16,17,18');
            return value;
        });
        replace(vscode.window, 'showSaveDialog', async options => {
            assert.ok(plan); plan.seen.push('save');
            assert.equal(options.title, 'Export publication inside the selected project');
            evidence.prompts.push({ stage: 'save', modality: 'instrumented API response', cancelled: plan.cancel === 'save',
                defaultUri: options.defaultUri.fsPath });
            return plan.cancel === 'save' ? undefined : vscode.Uri.file(path.join(root, plan.destination));
        });
        replace(vscode.window, 'showErrorMessage', async message => { errors.push(message); });
        replace(vscode.window, 'showInformationMessage', async message => { notifications.push(message); });
        const spawn = replace(childProcess, 'spawn', function (executable, args, options) {
            const child = spawn.call(this, executable, args, options);
            if (args?.[0]?.endsWith('/out/publication-helper.cjs')) {
                assert.equal(executable, '/usr/bin/node');
                assert.equal(options.cwd, root);
                assert.equal(options.shell, false);
                const record = { executable, args, cwd: options.cwd, stdout: '', stderr: '', request: '' };
                evidence.helpers.push(record);
                const end = child.stdin.end;
                child.stdin.end = function (data, ...rest) {
                    record.request = JSON.parse(String(data));
                    return end.call(this, data, ...rest);
                };
                child.stdout.on('data', chunk => { record.stdout += chunk; });
                child.stderr.on('data', chunk => { record.stderr += chunk; });
                child.once('close', (code, signal) => {
                    record.code = code; record.signal = signal;
                    if (plan.queue) {
                        queueCloseObserved = !queueComplete && fsSync.readFileSync(path.join(root, 'generated.txt'), 'utf8').startsWith('queue sentinel');
                    }
                });
                if (plan.queue) {
                    queuePromise = vscode.commands.executeCommand('literate.process').then(() => { queueComplete = true; });
                }
            }
            return child;
        });
        const baseline = JSON.parse(await fs.readFile(path.join(run, 'baseline.json'), 'utf8'));
        const extension = vscode.extensions.getExtension('jesterking.literate');
        assert.ok(extension);
        assert.equal(extension.extensionPath, path.resolve(__dirname, '../../..'));
        await extension.activate();
        assert.equal(extension.isActive, true);
        for (const command of ['literate.exportLatex', 'literate.exportPdf', 'literate.process']) {
            assert.ok((await vscode.commands.getCommands(true)).includes(command), `${command} registered through activation`);
        }
        await delay(600);
        assert.deepEqual(await inventory(root), baseline, 'Activation is read-only, including mtimes');
        assert.equal(evidence.helpers.length, 0);
        evidence.checks.push('integrated activation registers commands; startup does not write or launch helper');
        for (const kind of ['Latex', 'Pdf']) {
            for (const cancel of ['folder', 'paper', 'margins', 'save']) {
                plan = { cancel, seen: [] };
                await vscode.commands.executeCommand(`literate.export${kind}`);
                assert.deepEqual(plan.seen, ['folder', 'paper', 'margins', 'save'].slice(0, ['folder', 'paper', 'margins', 'save'].indexOf(cancel) + 1));
                assert.deepEqual(errors, []);
                assert.equal(evidence.helpers.length, 0);
                assert.deepEqual(await inventory(root), baseline, `${kind} cancellation at ${cancel} must not write`);
                evidence.checks.push(`${kind}: cancel ${cancel}; no helper, no file changes`);
            }
        }
        const documents = [];
        for (const [name, text] of [
            ['index.literate', '# UnsavedIndexMarker\n\n[Chapter](chapter.html)\n'],
            ['chapter.literate', '# UnsavedChapterMarker\n\n```text: <<probe.*>>= generated.txt $\nunsaved generated body\n```\n\n```mermaid\nflowchart TD\n    A[HostSnapshot] --> B[RealHelper]\n```\n']
        ]) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, name)));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
            assert.equal(await vscode.workspace.applyEdit(edit), true);
            assert.equal(document.isDirty, true);
            documents.push(document);
        }
        await vscode.window.showTextDocument(documents[1]);
        await vscode.commands.executeCommand('literate.process');
        for (const document of documents) {
            const name = path.basename(document.uri.fsPath);
            assert.equal(document.isDirty, true);
            assert.deepEqual((await inventory(root))[name], baseline[name], 'Editing must not save source buffers');
        }
        assert.equal(evidence.helpers.length, 0, 'Ordinary edit/generation must not publish');
        // Existing edit listeners intentionally generate ordinary outputs. Make one stale
        // only after that queue drains, so its rewrite proves the later explicit process ran.
        await fs.writeFile(path.join(root, 'generated.txt'), 'queue sentinel: awaiting explicit generation\n');
        for (const [kind, destination] of [['Latex', 'host-book.tex'], ['Pdf', 'host-book.pdf']]) {
            const before = await inventory(root);
            plan = { seen: [], destination, queue: kind === 'Latex' };
            await vscode.commands.executeCommand(`literate.export${kind}`);
            if (queuePromise) { await queuePromise; queuePromise = undefined; }
            assert.deepEqual(errors, [], errors.join('\n'));
            assert.deepEqual(plan.seen, ['paper', 'margins', 'save']);
            assert.ok(notifications.includes(`Exported ${destination}`));
            const helper = evidence.helpers.at(-1);
            assert.equal(helper.code, 0, helper.stderr);
            assert.equal(helper.signal, null);
            assert.equal(JSON.parse(helper.stdout).ok, true);
            assert.equal(helper.request.args[0], kind.toLowerCase());
            assert.ok(helper.request.args.includes('/usr/bin/chromium-browser'));
            for (const document of documents) {
                const name = path.basename(document.uri.fsPath);
                assert.equal(helper.request.documents.find(item => item.path === name)?.text, document.getText());
                assert.equal(document.isDirty, true);
                assert.deepEqual((await inventory(root))[name], baseline[name], `${name} must remain unsaved`);
            }
            if (kind === 'Latex') {
                const tex = await fs.readFile(path.join(root, destination), 'utf8');
                assert.match(tex, /UnsavedIndexMarker/); assert.match(tex, /UnsavedChapterMarker/);
                assert.doesNotMatch(tex, /SavedIndexMarker|SavedChapterMarker/);
                assert.match(tex, /a5paper/);
                assert.ok(queueCloseObserved, 'generation stays queued until actual helper close');
                assert.equal(queueComplete, true);
                assert.match(await fs.readFile(path.join(root, 'generated.txt'), 'utf8'), /unsaved generated body/);
                evidence.checks.push('real generation waits behind LaTeX helper on integrated shared queue, then writes dirty snapshot');
            } else {
                assert.equal((await fs.readFile(path.join(root, destination))).subarray(0, 5).toString(), '%PDF-');
                const result = await promisify(childProcess.execFile)('pdftotext', [path.join(root, destination), '-'], { timeout: 15000 });
                await fs.writeFile(path.join(run, 'pdf-text.txt'), result.stdout);
                assert.match(result.stdout, /UnsavedIndexMarker/); assert.match(result.stdout, /UnsavedChapterMarker/);
                assert.doesNotMatch(result.stdout, /SavedIndexMarker|SavedChapterMarker/);
                const after = await inventory(root);
                delete after[destination];
                assert.deepEqual(after, before, 'PDF publishes only the requested PDF');
            }
            evidence.checks.push(`${kind}: real helper exports unsaved index and chapter without saving; real Mermaid browser`);
        }
        assert.equal(evidence.helpers.length, 2);
        evidence.ok = true;
        console.log('M5_HOST_PUBLICATION_PASS', vscode.version, JSON.stringify(evidence.checks));
    } catch (error) {
        evidence.ok = false;
        evidence.failure = error.stack || String(error);
        throw error;
    } finally {
        for (const restore of [...originals.values()].reverse()) { restore(); }
        client?.close();
        evidence.errors = errors;
        evidence.notifications = notifications;
        await fs.writeFile(path.join(run, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    }
};
