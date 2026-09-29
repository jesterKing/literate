// Real VS Code code-action checks. Never adapt or execute server Commands as edits.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
exports.actionsHost = async ({ root, launch, evidence, traces, check, query, pos, replace, settle, waitDiagnostics }) => {
    const source = await vscode.workspace.openTextDocument(path.join(root, 'style.literate'));
    const fragment = () => new vscode.Range(pos(source, '.typo {', 0), pos(source, '    colr: red;\n}'));
    const snapshots = () => vscode.workspace.textDocuments.filter(d => d.uri.fsPath.startsWith(root + path.sep))
        .map(document => ({ document, text: document.getText(), version: document.version }));
    const unchanged = (before, except) => {
        for (const item of before) {
            if (item.document === except) { continue; }
            assert.equal(item.document.getText(), item.text, 'Unrelated open buffer text remains unchanged');
            assert.equal(item.document.version, item.version, 'Unrelated open buffer version remains unchanged');
        }
    };
    function messages(text) {
        const buffer = Buffer.from(text), result = []; let start = 0;
        while (start < buffer.length) {
            const end = buffer.indexOf('\r\n\r\n', start); if (end < 0) { break; }
            const match = /Content-Length: (\d+)/i.exec(buffer.subarray(start, end).toString()); assert.ok(match);
            const length = Number(match[1]); if (buffer.length < end + 4 + length) { break; }
            result.push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())); start = end + 4 + length;
        }
        return result;
    }
    function serialize(action) {
        return { title: action.title, kind: action.kind?.value, command: action.command, disabled: action.disabled,
            diagnostics: action.diagnostics, edits: action.edit?.entries().map(([uri, edits]) => ({ uri: uri.toString(), edits })) };
    }
    async function actions(range) {
        const before = snapshots();
        const result = await query('vscode.executeCodeActionProvider', source, range, 'quickfix');
        unchanged(before);
        evidence.requests[evidence.requests.length - 1].codeActions = (result || []).map(serialize);
        return result || [];
    }
    function safe(action, bound) {
        assert.equal(action.command, undefined, 'Never accept executable server commands');
        assert.equal(action.disabled, undefined);
        assert.ok(action.edit instanceof vscode.WorkspaceEdit, 'Eager edit-only action');
        assert.equal(action.kind?.value, 'quickfix');
        const entries = action.edit.entries(); assert.equal(entries.length, 1);
        assert.equal(entries[0][0].toString(), source.uri.toString(), 'Only original literate source URI');
        assert.ok(entries[0][1].length);
        for (const edit of entries[0][1]) {
            assert.ok(bound.contains(edit.range), 'Every edit is inside the current fragment, never header/prose/other fragment');
            assert.equal(source.validateRange(edit.range).isEqual(edit.range), true);
            assert.equal(typeof edit.newText, 'string');
        }
        for (const diagnostic of action.diagnostics || []) { assert.ok(bound.contains(diagnostic.range), 'Attached diagnostic maps into current fragment'); }
    }
    let diagnostic;
    await check('Mason CSS deterministic unknownProperties diagnostic maps into action fragment', async () => {
        await waitDiagnostics(source, 'CSS unknown property for code action', ds => ds.some(d => d.code === 'unknownProperties' && d.sourceText === 'colr'));
        diagnostic = vscode.languages.getDiagnostics(source.uri).find(d => d.code === 'unknownProperties' && source.getText(d.range) === 'colr');
        assert.ok(diagnostic); assert.ok(fragment().contains(diagnostic.range));
    });
    await check('Real Mason CSS command-only Rename to color is rejected and request is read-only', async () => {
        assert.ok(diagnostic, 'Real CSS diagnostic prerequisite');
        const result = await actions(diagnostic.range);
        const trace = traces.find(t => t.command === launch.servers.css.command); assert.ok(trace && !trace.truncated);
        const sent = messages(trace.stdin).filter(m => m.method === 'textDocument/codeAction').pop(); assert.ok(sent, 'Actual server request observed');
        assert.equal(sent.params.context.triggerKind, 1); assert.deepEqual(sent.params.context.only, ['quickfix']);
        assert.ok(sent.params.context.diagnostics.some(d => d.code === 'unknownProperties'));
        assert.ok(sent.params.textDocument.uri.endsWith('/style.css'), 'Request uses projection, response must map back');
        const reply = messages(trace.stdout).find(m => m.id === sent.id && !m.method); assert.ok(reply);
        assert.ok(reply.result.some(a => a.title === "Rename to 'color'" && a.command === '_css.applyCodeAction'), 'Installed Mason offers the deterministic legacy Command');
        assert.ok(reply.result.every(a => a.command === '_css.applyCodeAction'), 'This installed server offers command-only fixes');
        assert.deepEqual(result, [], 'No legacy Command may survive as an accepted action');
        evidence.cssCodeActionProtocol = { request: sent, reply, accepted: result.map(serialize) };
        for (const action of result) { safe(action, fragment()); }
        for (const raw of reply.result.filter(a => a.command !== undefined)) {
            assert.ok(!result.some(a => a.title === raw.title), 'Command-bearing server item cannot surface as an action');
        }
    });
    const configuration = vscode.workspace.getConfiguration('literate');
    const installed = configuration.inspect('languageServers').globalValue;
    try {
        await configuration.update('languageServers', { ...installed, css: launch.controlledCss }, vscode.ConfigurationTarget.Global);
        await check('Controlled stdio CSS edit-only action is read-only, mapped and applies source-only', async () => {
            await waitDiagnostics(source, 'Controlled CSS diagnostic', ds => ds.some(d => d.source === 'acceptance-css' && d.sourceText === 'colr'));
            const controlledDiagnostic = vscode.languages.getDiagnostics(source.uri).find(d => d.source === 'acceptance-css' && source.getText(d.range) === 'colr');
            assert.ok(controlledDiagnostic); assert.ok(fragment().contains(controlledDiagnostic.range));
            const result = await actions(controlledDiagnostic.range);
            assert.equal(result.length, 1, 'Exactly one controlled eager quickfix through the actual VS Code provider');
            const [action] = result; assert.equal(action.title, "Controlled CSS: rename to 'color'");
            for (const item of result) { safe(item, fragment()); }

            const trace = traces.find(t => t.command === launch.controlledCss.command); assert.ok(trace && !trace.truncated);
            const sent = messages(trace.stdin).filter(m => m.method === 'textDocument/codeAction').pop(); assert.ok(sent);
            assert.equal(sent.params.context.triggerKind, 1); assert.deepEqual(sent.params.context.only, ['quickfix']);
            const reply = messages(trace.stdout).find(m => m.id === sent.id && !m.method); assert.ok(reply);
            assert.equal(reply.result.length, 1); assert.equal(reply.result[0].command, undefined);
            assert.equal(reply.result[0].diagnostics.length, 1);
            assert.deepEqual(reply.result[0].diagnostics[0].range, sent.params.range);
            assert.deepEqual(Object.keys(reply.result[0].edit.changes), [sent.params.textDocument.uri]);
            assert.ok(sent.params.textDocument.uri.endsWith('/style.css'));
            assert.notEqual(sent.params.range.start.line, controlledDiagnostic.range.start.line, 'Nontrivial generated-to-source offset');
            evidence.controlledCodeActionProtocol = { request: sent, reply, accepted: result.map(serialize) };
            const edits = action.edit.get(source.uri); assert.equal(edits.length, 1);
            assert.equal(source.getText(edits[0].range), 'colr'); assert.equal(edits[0].newText, 'color');
            const before = snapshots(), text = source.getText(), start = source.offsetAt(edits[0].range.start), end = source.offsetAt(edits[0].range.end);
            assert.equal(await vscode.workspace.applyEdit(action.edit), true);
            assert.equal(source.getText(), text.slice(0, start) + 'color' + text.slice(end)); unchanged(before, source);
            await settle();
            await waitDiagnostics(source, 'Controlled CSS quick fix clears diagnostic', ds => !ds.some(d => d.source === 'acceptance-css'));
            evidence.controlledCodeActionApplied = { action: serialize(action), before: text, after: source.getText() };
        });
        await check('Controlled server cross-fragment and prose code-action requests are rejected before transport', async () => {
            // Restore a live actionable diagnostic, so empty results cannot be attributed to a fixed document.
            if (source.getText().includes('    color: red;')) { await replace(source, '    color: red;', '    colr: red;'); }
            await waitDiagnostics(source, 'Controlled diagnostic before negative ranges', ds => ds.some(d => d.source === 'acceptance-css' && d.sourceText === 'colr'));
            const trace = traces.find(t => t.command === launch.controlledCss.command); assert.ok(trace);
            const count = () => messages(trace.stdin).filter(m => m.method === 'textDocument/codeAction').length;
            const before = count();
            assert.deepEqual(await actions(new vscode.Range(pos(source, 'CSS action prose sentinel.', 0), pos(source, '.typo {'))), []);
            assert.deepEqual(await actions(new vscode.Range(pos(source, 'CSS action prose sentinel.', 0), pos(source, 'CSS action prose sentinel.'))), []);
            assert.deepEqual(await actions(new vscode.Range(pos(source, '.color {', 0), pos(source, '    colr: red;'))), []);
            assert.equal(count(), before, 'Unmapped/cross-fragment requests never reach controlled server');
            evidence.controlledNegativeRanges = { codeActionRequestsBefore: before, codeActionRequestsAfter: count(), liveDiagnostic: true };
        });
    } finally {
        await configuration.update('languageServers', installed, vscode.ConfigurationTarget.Global);
        await settle();
    }
    await check('Native missing-fragment quick fix coexists and applies a source-only definition', async () => {
        const original = source.getText();
        try {
            await replace(source, '.typo {', '/* <<acceptance missing>> */\n.typo {');
            await waitDiagnostics(source, 'Native missing-fragment diagnostic', ds => ds.some(d => d.code === 'missing-fragment'));
            const missing = vscode.languages.getDiagnostics(source.uri).find(d => d.code === 'missing-fragment'); assert.ok(missing);
            const result = await actions(missing.range);
            const action = result.find(a => a.title === 'Create fragment for <<acceptance missing>>'); assert.ok(action, 'Native provider remains registered beside language provider');
            assert.equal(action.command, undefined); assert.equal(action.kind?.value, 'quickfix');
            const entries = action.edit.entries(); assert.equal(entries.length, 1); assert.equal(entries[0][0].toString(), source.uri.toString());
            const edits = entries[0][1]; assert.equal(edits.length, 1); assert.ok(edits[0].range.isEmpty);
            assert.match(edits[0].newText, /~~~ css : <<acceptance missing>>=/);
            const before = snapshots(), text = source.getText(), offset = source.offsetAt(edits[0].range.start);
            assert.equal(await vscode.workspace.applyEdit(action.edit), true);
            assert.equal(source.getText(), text.slice(0, offset) + edits[0].newText + text.slice(offset)); unchanged(before, source);
            await settle(); await waitDiagnostics(source, 'Native quick fix clears missing fragment', ds => !ds.some(d => d.code === 'missing-fragment'));
            evidence.nativeCodeActionApplied = { action: serialize(action), before: text, after: source.getText() };
        } finally {
            if (source.getText() !== original) {
                const edit = new vscode.WorkspaceEdit(); edit.replace(source.uri, new vscode.Range(source.positionAt(0), source.positionAt(source.getText().length)), original);
                assert.equal(await vscode.workspace.applyEdit(edit), true); await settle();
            }
        }
    });
};
