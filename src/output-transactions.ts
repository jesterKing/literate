import { safeRelativePath } from './engine';

export interface TransactionFile { path: string; content: Uint8Array; }
export interface TransactionIO {
    inspect(path: string): Promise<'missing' | 'file' | 'directory'>;
    read(path: string): Promise<Uint8Array>;
    mkdir(path: string): Promise<void>;
    writeNew(path: string, content: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    removeFile(path: string): Promise<void>;
    removeDirectory(path: string): Promise<void>;
    nonce(): string;
}

export class TransactionDirectoryError extends Error {
    constructor(public readonly createdPath: string, message = 'Directory created, cleanup failed') {
        super(`${message}: ${createdPath}`);
        this.name = 'TransactionDirectoryError';
    }
}

export class OutputTransactionError extends Error {
    constructor(
        public readonly code: 'preflight_failed' | 'rolled_back' | 'rollback_failed' | 'cleanup_failed',
        public readonly committed: boolean,
        public readonly paths: string[],
        public readonly recoveryPaths: string[],
        public readonly originalError: unknown,
        details: string[] = [],
        public readonly changedPaths: string[] = []
    ) {
        super(`${committed ? 'committed, cleanup failed' : code}: ${paths.join(', ')}; ${String(originalError)}`
            + (details.length ? `; ${details.join('; ')}` : '')
            + (recoveryPaths.length ? `; recovery locations: ${recoveryPaths.join(', ')}` : ''));
        this.name = 'OutputTransactionError';
    }
}

interface PendingOutput extends TransactionFile {
    original: boolean;
    stage: string;
    backup: string;
    backupAttempted: boolean;
    installAttempted: boolean;
}
interface TransactionState {
    outputs: PendingOutput[];
    directories: string[];
    owned: string[];
    parents: string[];
    active: string;
}
interface TransactionFailure { path: string; error: unknown; }

function parentPaths(path: string): string[] {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function normalizeOutputs(files: readonly TransactionFile[]): TransactionFile[] {
    const seen = new Map<string, string>();
    const outputs = files.map(file => {
        const path = safeRelativePath(file.path);
        if (!path) { throw new OutputTransactionError('preflight_failed', false, [file.path], [], 'Unsafe output path'); }
        const key = path.toLowerCase();
        const previous = seen.get(key);
        if (previous) { throw new OutputTransactionError('preflight_failed', false, [previous, path], [], 'Duplicate output path'); }
        seen.set(key, path);
        return { path, content: new Uint8Array(file.content) };
    });
    for (const file of outputs) {
        for (const parent of parentPaths(file.path)) {
            const collision = seen.get(parent.toLowerCase());
            if (collision) {
                throw new OutputTransactionError('preflight_failed', false, [collision, file.path], [], 'Output parent collision');
            }
        }
    }
    return outputs;
}

async function preflight(files: readonly TransactionFile[], io: TransactionIO,
    checkCancelled?: () => void): Promise<TransactionState> {
    const normalized = normalizeOutputs(files);
    const state: TransactionState = { outputs: [], directories: [], owned: [], parents: [], active: '' };
    try {
        checkCancelled?.();
        for (const file of normalized) {
            for (const parent of parentPaths(file.path)) {
                state.active = parent;
                if (await io.inspect(parent) === 'file') { throw new Error('Output parent is a file'); }
            }
            state.active = file.path;
            const type = await io.inspect(file.path);
            if (type === 'directory') { throw new Error('Output is a directory'); }
            if (type === 'file') {
                const old = await io.read(file.path);
                if (old.length === file.content.length && old.every((byte, index) => byte === file.content[index])) { continue; }
            }
            state.outputs.push({ ...file, original: type === 'file', stage: '', backup: '',
                backupAttempted: false, installAttempted: false });
        }
        await reserveDirectories(state, normalized, io);
        checkCancelled?.();
        return state;
    } catch (error) {
        throw new OutputTransactionError('preflight_failed', false, [state.active], [], error);
    }
}

async function reserveDirectories(state: TransactionState, files: TransactionFile[], io: TransactionIO): Promise<void> {
    const byParent = new Map<string, string>();
    const occupied = new Set(files.flatMap(file => [file.path, ...parentPaths(file.path)]).map(path => path.toLowerCase()));
    for (const [index, output] of state.outputs.entries()) {
        const parent = parentPaths(output.path).pop() || '';
        let directory = byParent.get(parent);
        if (!directory) {
            state.active = output.path;
            const nonce = io.nonce();
            if (!/^[a-zA-Z0-9_-]+$/.test(nonce)) { throw new Error('Invalid transaction nonce'); }
            directory = `${parent ? parent + '/' : ''}.literate-txn-${nonce}`;
            state.active = directory;
            if (occupied.has(directory.toLowerCase()) || await io.inspect(directory) !== 'missing') {
                throw new Error('Transaction stage collision');
            }
            byParent.set(parent, directory);
            state.directories.push(directory);
        }
        output.stage = `${directory}/${index}.stage`;
        output.backup = `${directory}/${index}.backup`;
    }
}

async function createDirectory(path: string, owned: string[], io: TransactionIO): Promise<void> {
    try { await io.mkdir(path); }
    catch (error) {
        if (error instanceof TransactionDirectoryError && error.createdPath === path) { owned.push(path); }
        throw error;
    }
    owned.push(path);
}

async function prepareOutputs(state: TransactionState, io: TransactionIO): Promise<void> {
    for (const output of state.outputs) {
        for (const parent of parentPaths(output.path)) {
            state.active = parent;
            const type = await io.inspect(parent);
            if (type === 'file') { throw new Error('Output parent is a file'); }
            if (type === 'missing') {
                await createDirectory(parent, state.parents, io);
            }
        }
    }
    for (const directory of state.directories) {
        state.active = directory;
        await createDirectory(directory, state.owned, io);
    }
    for (const output of state.outputs) {
        state.active = output.stage;
        await io.writeNew(output.stage, output.content);
    }
}

async function installOutputs(state: TransactionState, io: TransactionIO): Promise<void> {
    for (const output of state.outputs) {
        state.active = output.path;
        if (output.original) {
            output.backupAttempted = true;
            await io.rename(output.path, output.backup);
        }
        output.installAttempted = true;
        await io.rename(output.stage, output.path);
    }
}

async function restoreBackup(output: PendingOutput, io: TransactionIO): Promise<void> {
    try { await io.rename(output.backup, output.path); }
    catch (error) {
        if (await io.inspect(output.backup) === 'missing' && await io.inspect(output.path) === 'file') { return; }
        throw error;
    }
}

async function undoOutput(output: PendingOutput, io: TransactionIO): Promise<void> {
    if (!output.backupAttempted && !output.installAttempted) { return; }
    const target = await io.inspect(output.path);
    if (output.original) {
        const backup = await io.inspect(output.backup);
        if (backup === 'missing' && !output.installAttempted && target === 'file') { return; }
        if (backup !== 'file') { throw new Error(`Original backup unavailable: ${output.backup}; target left untouched`); }
    }
    if (target !== 'missing') {
        if (!output.installAttempted || target !== 'file' || await io.inspect(output.stage) !== 'missing') {
            throw new Error('Ambiguous target/stage state; target left untouched');
        }
        await io.removeFile(output.path);
    }
    if (output.original) { await restoreBackup(output, io); }
}

async function rollbackOutputs(state: TransactionState, io: TransactionIO): Promise<TransactionFailure[]> {
    const failures: TransactionFailure[] = [];
    for (const output of [...state.outputs].reverse()) {
        try { await undoOutput(output, io); }
        catch (error) { failures.push({ path: output.path, error }); }
    }
    return failures;
}

async function cleanupTransaction(state: TransactionState, io: TransactionIO, rolledBack: boolean): Promise<TransactionFailure[]> {
    const failures: TransactionFailure[] = [];
    const attempt = async (path: string, directory: boolean): Promise<void> => {
        try {
            if (await io.inspect(path) === 'missing') { return; }
            if (directory) { await io.removeDirectory(path); }
            else { await io.removeFile(path); }
        } catch (error) { failures.push({ path, error }); }
    };
    for (const output of state.outputs) {
        if (!state.owned.includes(output.stage.slice(0, output.stage.lastIndexOf('/')))) { continue; }
        await attempt(output.stage, false);
        await attempt(output.backup, false);
    }
    for (const directory of [...state.owned].reverse()) { await attempt(directory, true); }
    if (rolledBack) {
        for (const parent of [...state.parents].reverse()) { await attempt(parent, true); }
    }
    return failures;
}

export async function commitOutputs(files: readonly TransactionFile[], io: TransactionIO,
    checkCancelled?: () => void): Promise<string[]> {
    const state = await preflight(files, io, checkCancelled);
    try {
        await prepareOutputs(state, io);
        checkCancelled?.();
        await installOutputs(state, io);
        checkCancelled?.();
    } catch (error) {
        let failures = await rollbackOutputs(state, io);
        if (!failures.length) { failures = await cleanupTransaction(state, io, true); }
        throw new OutputTransactionError(failures.length ? 'rollback_failed' : 'rolled_back', false,
            [...new Set([state.active, ...failures.map(failure => failure.path)])],
            failures.length ? [...state.owned, ...state.parents] : [], error,
            failures.map(failure => `${failure.path}: ${String(failure.error)}`));
    }
    const failures = await cleanupTransaction(state, io, false);
    if (failures.length) {
        throw new OutputTransactionError('cleanup_failed', true, failures.map(failure => failure.path),
            state.owned, failures[0].error, failures.map(failure => `${failure.path}: ${String(failure.error)}`),
            state.outputs.map(output => output.path));
    }
    return state.outputs.map(output => output.path);
}
