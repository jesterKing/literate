// Bounded real Mason protocol probe; not a replacement for VS Code acceptance.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
async function main() {
    const run = await fs.mkdtemp(path.resolve(__dirname, '../../../out/language-css-actions-probe-'));
    const command = process.env.LANGUAGE_GROUPS_CSS || '/home/jesterking/.local/share/nvim/mason/bin/vscode-css-language-server';
    const child = spawn(command, ['--stdio'], { cwd: run, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const evidence = { command, messages: [], stderr: '' }, pending = new Map();
    let sequence = 0, buffer = Buffer.alloc(0);
    const send = message => {
        evidence.messages.push({ direction: 'send', message });
        const body = Buffer.from(JSON.stringify(message)); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body);
    };
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params });
    });
    const fail = error => { for (const promise of pending.values()) { promise.reject(error); } pending.clear(); };
    child.once('error', fail); child.once('exit', () => fail(new Error('Server exited')));
    child.stderr.on('data', data => { evidence.stderr += data.toString(); });
    child.stdout.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (true) {
            const end = buffer.indexOf('\r\n\r\n'); if (end < 0) { return; }
            const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
            if (buffer.length < end + 4 + length) { return; }
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length); evidence.messages.push({ direction: 'receive', message });
            if (message.method && message.id !== undefined) {
                send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
            } else if (pending.has(message.id)) {
                const promise = pending.get(message.id); pending.delete(message.id);
                if (message.error) { promise.reject(new Error(JSON.stringify(message.error))); } else { promise.resolve(message.result); }
            }
        }
    });
    const timer = setTimeout(() => { fail(new Error('Probe exceeded 15 seconds')); child.kill('SIGKILL'); }, 15000);
    try {
        const rootUri = pathToFileURL(run).toString(), uri = pathToFileURL(path.join(run, 'probe.css')).toString();
        await request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'probe' }],
            capabilities: { textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } },
                diagnostic: { dynamicRegistration: false } } } });
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'css', version: 1, text: '.typo {\n    colr: red;\n}\n' } } });
        evidence.diagnostics = await request('textDocument/diagnostic', { textDocument: { uri } });
        const diagnostic = evidence.diagnostics.items.find(d => d.code === 'unknownProperties');
        if (!diagnostic) { throw new Error('No deterministic unknownProperties diagnostic'); }
        evidence.actions = await request('textDocument/codeAction', { textDocument: { uri }, range: diagnostic.range,
            context: { diagnostics: [diagnostic], only: ['quickfix'], triggerKind: 1 } });
        console.log(JSON.stringify({ run, diagnostics: evidence.diagnostics, actions: evidence.actions }, null, 2));
    } finally {
        clearTimeout(timer); child.kill('SIGKILL');
        await fs.writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
    }
}
if (require.main === module) { main().catch(error => { console.error(error); process.exitCode = 1; }); }
