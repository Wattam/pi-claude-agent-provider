import assert from "node:assert/strict";
import test from "node:test";
import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { ChildLauncher } from "../../src/io.js";
import { baseOptions, sessionOptions } from "../../src/query-options.js";
import { EXECUTABLE, FakeClaude } from "../fixtures/fake-claude.js";

const fake = new FakeClaude();
const env = { PATH: "/usr/bin" };
const launch = new ChildLauncher(fake.io().spawn).launch;

function session(overrides: Partial<Parameters<typeof sessionOptions>[0]> = {}): Options {
    return sessionOptions({
        base: baseOptions(EXECUTABLE, env, launch), cwd: "/work/project", model: "sonnet", effort: "high",
        thinking: "adaptive", systemPrompt: "Pi prompt", hooks: { PreToolUse: [] }, toolServer: undefined,
        start: { sessionId: "11111111-1111-4111-8111-111111111111" }, ...overrides,
    });
}

test("base options disable Claude Code settings, skills, built-in tools, hooks, and external MCP", () => {
    const { spawnClaudeCodeProcess, ...options } = baseOptions(EXECUTABLE, env, launch);
    assert.equal(spawnClaudeCodeProcess, launch, "Pi owns every Claude Code launch");
    assert.deepEqual(options, {
        pathToClaudeCodeExecutable: EXECUTABLE, env, settingSources: [],
        settings: { disableAllHooks: true }, strictMcpConfig: true, skills: [], tools: [], permissionMode: "dontAsk",
        allowedTools: ["mcp__pi__*"], verbatimPrompts: true,
    });
});

test("session options carry Pi's full custom prompt without a Claude Code preset or snapshot", () => {
    const options = session();
    assert.deepEqual(options.systemPrompt, { type: "custom", prompt: "Pi prompt", snapshot: false });
    assert.equal(options.persistSession, true);
    assert.equal(options.includePartialMessages, true);
    assert.equal(options.cwd, "/work/project");
    assert.equal(options.model, "sonnet");
    assert.equal(options.effort, "high");
    assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(options.sessionId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.settingSources, []);
});

test("session options omit effort when Pi selects none and disable thinking for effort-less models", () => {
    const options = session({ effort: undefined, thinking: "disabled" });
    assert.equal("effort" in options, false);
    assert.deepEqual(options.thinking, { type: "disabled" });
});

test("session options register only the private Pi tool server and the requested resume point", () => {
    const toolServer = { type: "sdk", name: "pi", instance: {} } as unknown as McpSdkServerConfigWithInstance;
    const options = session({ toolServer, start: { resume: "claude-session", resumeSessionAt: "assistant-uuid" } });
    assert.deepEqual(options.mcpServers, { pi: toolServer });
    assert.equal(options.resume, "claude-session");
    assert.equal(options.resumeSessionAt, "assistant-uuid");
    assert.equal(options.sessionId, undefined);
});
