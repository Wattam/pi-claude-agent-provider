import { FakeClaude } from "./fake-claude.js";

// Run the protocol fixture across real OS pipes. Never starts Claude Code or submits inference.
const child = new FakeClaude().spawn({
    command: process.execPath,
    args: process.argv.slice(2),
    env: process.env,
    signal: new AbortController().signal,
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
