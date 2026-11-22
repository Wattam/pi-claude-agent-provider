import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { STDERR_TAIL_CHARS } from "../../src/constants.js";
import { ChildLauncher, childEnv, realIO } from "../../src/io.js";

const ROUTING_VARIABLES = [
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "MCP_TOOL_TIMEOUT", "AWS_BEARER_TOKEN_BEDROCK",
];

const ISOLATION = {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: "1",
    MAX_MCP_OUTPUT_TOKENS: "200000",
};

async function tempDir(t: TestContext): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-io-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

async function script(path: string, body: string, mode = 0o755): Promise<void> {
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, mode);
}

test("child environment drops API, cloud, and endpoint routing and adds Claude Code isolation", () => {
    const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin", HOME: "/home/fixture", UNSET: undefined,
        ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://gateway.invalid", ANTHROPIC_AUTH_TOKEN: "token",
        ...Object.fromEntries(ROUTING_VARIABLES.map(name => [name, "1"])),
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0", DISABLE_AUTO_COMPACT: "0", CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: "0",
    };
    const snapshot = { ...base };
    const env = childEnv(base);
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/fixture", ...ISOLATION });
    assert.deepEqual(base, snapshot);
});

test("child environment never mutates the Pi process environment", () => {
    const before = { ...process.env };
    childEnv({ ...process.env, ANTHROPIC_API_KEY: "sk-ant" });
    assert.deepEqual({ ...process.env }, before);
});

test("claude lookup returns the first executable on PATH and skips non-executable files", async (t) => {
    const first = await tempDir(t);
    const second = await tempDir(t);
    const empty = await tempDir(t);
    await script(join(first, "claude"), "exit 0", 0o644);
    await script(join(second, "claude"), "exit 0");
    const previous = process.env.PATH;
    t.after(() => {
        process.env.PATH = previous;
    });
    process.env.PATH = [empty, first, second].join(delimiter);
    assert.equal(realIO.which(), join(second, "claude"));
    process.env.PATH = [empty, first].join(delimiter);
    assert.equal(realIO.which(), undefined);
});

test("production launcher preserves argv, cwd, isolated env, and piped input and output", async (t) => {
    const dir = await tempDir(t);
    const argument = "literal $(not-a-command); 'quoted'";
    const child = realIO.spawn({
        command: process.execPath,
        args: ["-e", [
            "let input = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', text => { input += text; });",
            "process.stdin.on('end', () => console.log(JSON.stringify({",
            "    args: process.argv.slice(1), cwd: process.cwd(), env: process.env, input,",
            "})));",
        ].join("\n"), argument],
        cwd: dir,
        env: { FIXTURE_VALUE: "isolated" },
        signal: new AbortController().signal,
    }, () => undefined);
    t.after(() => { child.kill("SIGKILL"); });
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
    child.stdin.end("Pi input");
    let output = "";
    for await (const chunk of child.stdout) output += chunk;
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(output), {
        args: [argument], cwd: dir, env: { FIXTURE_VALUE: "isolated" }, input: "Pi input",
    });
});

test("production launcher exposes direct SIGKILL control", async (t) => {
    const child = realIO.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        env: {}, signal: new AbortController().signal,
    }, () => undefined);
    t.after(() => { child.kill("SIGKILL"); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>(resolve => { child.stdout.once("data", () => resolve()); });
    assert.equal(child.exitCode, null);
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    assert.equal(child.signalCode, "SIGKILL");
});

test("production launcher honors the SDK's forwarded abort signal", async (t) => {
    const controller = new AbortController();
    const child = realIO.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        env: {}, signal: controller.signal,
    }, () => undefined);
    t.after(() => { child.kill("SIGKILL"); });
    const aborted = new Promise<Error>(resolve => { child.once("error", resolve); });
    const exited = new Promise<NodeJS.Signals | null>(resolve => {
        child.once("exit", (_code, signal) => resolve(signal));
    });
    await new Promise<void>(resolve => { child.stdout.once("data", () => resolve()); });
    controller.abort();
    assert.equal((await aborted).name, "AbortError");
    assert.equal(await exited, "SIGTERM");
});

test("the child launcher keeps the stderr tail of the Claude Code process it started", async () => {
    const launcher = new ChildLauncher(realIO.spawn);
    assert.equal(launcher.tail, "");
    const child = launcher.launch({
        command: process.execPath,
        args: ["-e", `process.stderr.write('x'.repeat(${STDERR_TAIL_CHARS}) + ' diagnostic\\n')`],
        env: {}, signal: new AbortController().signal,
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
    assert.equal(exitCode, 0);
    assert.equal(launcher.tail.length, STDERR_TAIL_CHARS - 1);
    assert.equal(launcher.tail.endsWith("x diagnostic"), true);
});

test("the child launcher kills a running child once and leaves an exited one alone", async () => {
    const signals: NodeJS.Signals[] = [];
    let spawned = 0;
    const launcher = new ChildLauncher((options, onStderr) => {
        spawned += 1;
        const started = realIO.spawn(options, onStderr);
        const kill = started.kill.bind(started);
        started.kill = (signal) => {
            signals.push(signal);
            return kill(signal);
        };
        return started;
    });
    launcher.kill();
    assert.equal(spawned, 0);
    assert.deepEqual(signals, []);
    const child = launcher.launch({
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        env: {}, signal: new AbortController().signal,
    });
    const exited = new Promise<NodeJS.Signals | null>(resolve => {
        child.once("exit", (_code, signal) => resolve(signal));
    });
    await new Promise<void>(resolve => { child.stdout.once("data", () => resolve()); });
    launcher.kill();
    assert.equal(await exited, "SIGKILL");
    assert.deepEqual(signals, ["SIGKILL"]);
    launcher.kill();
    assert.deepEqual(signals, ["SIGKILL"]);
});

test("auth status runs `claude auth status --json` with the isolated env and keeps non-zero exits", async (t) => {
    const dir = await tempDir(t);
    const executable = join(dir, "claude");
    await script(executable, [
        "echo '{\"loggedIn\":false}'",
        "echo \"args=$*\" >&2",
        "echo \"fixture=$FIXTURE_VALUE api=${ANTHROPIC_API_KEY:-none}\" >&2",
        "exit 3",
    ].join("\n"));
    const result = await realIO.authStatus(executable, { PATH: process.env.PATH ?? "", FIXTURE_VALUE: "kept" });
    assert.deepEqual(result, {
        stdout: "{\"loggedIn\":false}\n",
        stderr: "args=auth status --json\nfixture=kept api=none\n",
        exitCode: 3,
    });
});

test("auth status rejects when the executable cannot start", async (t) => {
    const dir = await tempDir(t);
    await assert.rejects(realIO.authStatus(join(dir, "missing-claude"), {}));
});

test("auth status rejects when aborted", async (t) => {
    const dir = await tempDir(t);
    const executable = join(dir, "claude");
    await script(executable, "sleep 5");
    const controller = new AbortController();
    const pending = realIO.authStatus(executable, { PATH: process.env.PATH ?? "" }, controller.signal);
    controller.abort();
    await assert.rejects(pending);
});
