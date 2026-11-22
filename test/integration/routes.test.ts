import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import {
    NOT_INSTALLED, NOT_LOGGED_IN, authStatusFailed, tooOld, unsupportedRoute,
} from "../../src/messages.js";
import { FakeClaude } from "../fixtures/fake-claude.js";
import { eventually, startPi } from "../fixtures/pi-host.js";

test("a missing claude executable fails with the install instruction", async (t) => {
    const fake = new FakeClaude();
    const { chat } = await startPi(t, { fake, io: fake.io({ which: () => undefined }) });
    const run = await chat.ask("hello");
    assert.equal(run.message.errorMessage, NOT_INSTALLED);
    assert.equal(fake.processes.length, 0);
});

test("a missing login or unreadable login status fails before Claude Code starts", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.auth = { loggedIn: false };
    assert.equal((await chat.ask("hello")).message.errorMessage, NOT_LOGGED_IN);
    fake.authFailure = new Error("auth status timed out");
    assert.equal((await chat.ask("hello")).message.errorMessage, authStatusFailed("auth status timed out"));
    assert.equal(fake.processes.length, 0);
});

test("API-key, cloud, and gateway logins are rejected before Claude Code starts", async (t) => {
    for (const [field, value] of [["apiProvider", "vertex"], ["authMethod", "console_api_key"]] as const) {
        const { fake, chat } = await startPi(t);
        fake.auth = { ...fake.auth, [field]: value };
        const run = await chat.ask("hello");
        assert.equal(run.message.errorMessage, unsupportedRoute(value));
        assert.equal(fake.processes.length, 0);
    }
});

test("a Claude Code session that reports a non-subscription route is stopped before any prompt", async (t) => {
    const routes: Partial<FakeClaude["account"]>[] = [
        { apiKeySource: "ANTHROPIC_API_KEY" }, { apiProvider: "bedrock" }, { tokenSource: "none" },
    ];
    for (const route of routes) {
        const { fake, chat } = await startPi(t);
        fake.account = { ...fake.account, ...route };
        const run = await chat.ask("hello");
        assert.match(run.message.errorMessage ?? "", /^Claude Agent requires the Claude subscription login/);
        assert.equal(fake.userMessages.length, 0);
        await eventually(() => fake.running.length === 0);
    }
});

test("an unsupported Claude Code version is stopped before any prompt", async (t) => {
    for (const version of ["2.1.200", undefined]) {
        const { fake, chat } = await startPi(t);
        fake.version = version;
        const run = await chat.ask("hello");
        assert.equal(run.message.errorMessage, tooOld(version));
        assert.equal(fake.userMessages.length, 0);
        await eventually(() => fake.running.length === 0);
    }
});

test("a Claude Code that ignores hook onFailure is reported as too old", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.hookOnFailure = false;
    const run = await chat.ask("hello");
    assert.equal(run.message.errorMessage, tooOld(undefined));
    assert.equal(fake.userMessages.length, 0);
    await eventually(() => fake.running.length === 0);
});

test("the Claude child environment drops API and routing credentials without changing Pi's environment", async (t) => {
    const before = { ...process.env };
    const { fake, chat } = await startPi(t);
    const run = await chat.ask("hello", {
        apiKey: "sk-pi-supplied", headers: { authorization: "Bearer pi" }, env: { ANTHROPIC_API_KEY: "sk-env" },
    } as Parameters<typeof chat.ask>[1]);
    assert.equal(run.message.stopReason, "stop");
    const env = fake.processes[0].options.env;
    const dropped = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN"];
    for (const name of dropped) {
        assert.equal(env[name], undefined, name);
    }
    assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(env.DISABLE_AUTO_COMPACT, "1");
    assert.equal(env.PATH, "/usr/bin");
    assert.doesNotMatch(JSON.stringify(fake.processes[0].options.args), /sk-pi-supplied|sk-env|Bearer pi/);
    assert.deepEqual({ ...process.env }, before);
});

test("Claude Code runs with Pi's full prompt and without its own settings, tools, or MCP servers", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("hello");
    const child = fake.processes[0];
    assert.equal(child.flags.get("setting-sources"), "");
    assert.equal(child.flags.get("tools"), "");
    assert.equal(child.flags.has("strict-mcp-config"), true);
    assert.equal(child.flags.get("permission-mode"), "dontAsk");
    assert.equal(child.flags.get("allowedTools"), "mcp__pi__*");
    assert.equal(child.options.command, "/fake/bin/claude");
    assert.equal(child.options.cwd, "/work/project");
    const expectedPrompt = getCurrentSystemPrompt(normalizeContext({
        systemPrompt: chat.systemPrompt, tools: chat.tools, messages: [],
    }).messages);
    assert.equal(child.systemPrompt, expectedPrompt);
    assert.match(child.systemPrompt ?? "", /CLAUDE\.md/);
    assert.deepEqual(child.initialize?.sdkMcpServers, ["pi"]);
    assert.deepEqual(Object.keys((child.initialize?.hooks as object | undefined) ?? {}), ["PreToolUse"]);
});

test("a slash-command-looking prompt reaches Claude as client-composed text", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("/compact everything and /loop");
    const [message] = fake.userMessages;
    assert.equal((message as unknown as { client_composed?: boolean }).client_composed, true);
    assert.deepEqual(message.message.content, [{ type: "text", text: "/compact everything and /loop" }]);
});
