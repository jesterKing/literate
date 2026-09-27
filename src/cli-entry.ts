import { run } from './cli';
void run(process.argv.slice(2)).then(code => { process.exitCode = code; });
