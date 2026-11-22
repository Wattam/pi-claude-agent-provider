import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolDeclaration, type Tool, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piToolName, shortName } from "../../src/tools/names.js";
import { createPendingTools } from "../../src/tools/pending.js";
import { toCallToolResult } from "../../src/tools/results.js";
import { createToolHooks, createToolServer } from "../../src/tools/server.js";
import { BASH_TOOL, READ_TOOL } from "../fixtures/pi-host.js";

const LIMIT = 64 - "mcp__pi__".length;
const CANCELLED: CallToolResult = { isError: true, content: [{ type: "text", text: "Cancelled by user." }] };
const OK: CallToolResult = { isError: false, content: [{ type: "text", text: "file body" }] };
const hash10 = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 10);

async function connect(t: TestContext, tools: Tool[]) {
    const pending = createPendingTools();
    const config = createToolServer(tools, pending);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = config.instance as unknown as { connect(transport: unknown): Promise<void>; close(): Promise<void> };
    await server.connect(serverSide);
    const client = new Client({ name: "fixture", version: "0" });
    await client.connect(clientSide);
    t.after(async () => {
        await client.close();
        await server.close();
    });
    return { config, client, pending };
}

test("valid Pi tool names pass through unchanged", () => {
    assert.equal(shortName("read"), "read");
    assert.equal(shortName("web-search_2"), "web-search_2");
    assert.equal(shortName("a".repeat(LIMIT)), "a".repeat(LIMIT));
});

test("invalid or overlong Pi tool names become unique MCP-safe names within the SDK limit", () => {
    assert.equal(shortName("ns.read"), `ns_read_${hash10("ns.read")}`);
    const long = "b".repeat(80);
    assert.equal(shortName(long), `${"b".repeat(LIMIT - 11)}_${hash10(long)}`);
    assert.equal(shortName(long).length, LIMIT);
    assert.notEqual(shortName("ns.read"), shortName("ns:read"));
});

test("SDK tool names map back only to offered Pi tools", () => {
    const tools = [READ_TOOL, { ...BASH_TOOL, name: "ns.bash" }];
    assert.equal(piToolName("mcp__pi__read", tools), "read");
    assert.equal(piToolName(`mcp__pi__${shortName("ns.bash")}`, tools), "ns.bash");
    assert.equal(piToolName("mcp__pi__write", tools), undefined);
    assert.equal(piToolName("Bash", tools), undefined);
});

test("a parked MCP call resolves exactly once with Pi's tool result", async () => {
    const pending = createPendingTools();
    pending.before("toolu_1", "mcp__pi__read");
    const call = pending.call("mcp__pi__read");
    pending.resolve("toolu_1", OK);
    assert.deepEqual(await call, OK);
    assert.throws(() => pending.resolve("toolu_1", OK), { message: "No waiting Claude tool call toolu_1" });
});

test("a result that arrives before the MCP call is delivered when the call starts", async () => {
    const pending = createPendingTools();
    pending.expect("toolu_1", "mcp__pi__read");
    pending.expect("toolu_2", "mcp__pi__bash");
    pending.resolve("toolu_1", OK);
    pending.resolve("toolu_2", CANCELLED);
    pending.before("toolu_1", "mcp__pi__read");
    assert.deepEqual(await pending.call("mcp__pi__read"), OK);
    pending.before("toolu_2", "mcp__pi__bash");
    assert.deepEqual(await pending.call("mcp__pi__bash"), CANCELLED);
});

test("an MCP call without its PreToolUse id or with a mismatched name is rejected", async () => {
    const pending = createPendingTools();
    await assert.rejects(pending.call("mcp__pi__read"),
        { message: "Claude invoked a Pi tool without its PreToolUse ID" });
    pending.expect("toolu_1", "mcp__pi__read");
    assert.throws(() => pending.expect("toolu_1", "mcp__pi__bash"), { message: "Mismatched Claude tool call toolu_1" });
});

test("clearing cancels every waiting call without leaving unresolved waits", async () => {
    const pending = createPendingTools();
    pending.before("toolu_1", "mcp__pi__read");
    const call = pending.call("mcp__pi__read");
    pending.expect("toolu_2", "mcp__pi__bash");
    pending.clear();
    assert.deepEqual(await call, CANCELLED);
    assert.throws(() => pending.resolve("toolu_2", OK), { message: "No waiting Claude tool call toolu_2" });
    await assert.rejects(pending.call("mcp__pi__read"),
        { message: "Claude invoked a Pi tool without its PreToolUse ID" });
});

test("Pi tool results keep text, images, empty content, and the error flag", () => {
    const message = (content: ToolResultMessage["content"], isError: boolean): ToolResultMessage => ({
        role: "toolResult", toolCallId: "toolu_1", toolName: "read", content, isError, timestamp: 1,
    });
    assert.deepEqual(toCallToolResult(message([
        { type: "text", text: "Blocked by hook" }, { type: "image", data: "aGk=", mimeType: "image/png" },
    ], true)), {
        isError: true,
        content: [{ type: "text", text: "Blocked by hook" }, { type: "image", data: "aGk=", mimeType: "image/png" }],
    });
    assert.deepEqual(toCallToolResult(message([], false)), { isError: false, content: [] });
});

test("the private MCP server lists only Pi's offered tools with their declarations", async (t) => {
    const nested: Tool = { name: "ns.find", description: "Find", parameters: Type.Object({ q: Type.String() }) };
    const { config, client } = await connect(t, [READ_TOOL, nested]);
    assert.equal(config.type, "sdk");
    assert.equal(config.name, "pi");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["read", shortName("ns.find")]);
    assert.deepEqual(tools[0].inputSchema, JSON.parse(JSON.stringify(toToolDeclaration(READ_TOOL).parameters)));
    assert.equal(tools[0].description, "Read a file");
    assert.equal(tools[0].annotations?.readOnlyHint, false);
    assert.deepEqual(tools[0]._meta, { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 });
});

test("an MCP tool call waits for Pi's result through the PreToolUse id", async (t) => {
    const { client, pending } = await connect(t, [READ_TOOL]);
    const hooks = createToolHooks(pending);
    const hook = hooks?.PreToolUse?.[0].hooks[0];
    assert.ok(hook);
    const hookOutput = await hook({
        hook_event_name: "PreToolUse", tool_name: "mcp__pi__read", tool_input: { path: "a.txt" },
            tool_use_id: "toolu_9",
        session_id: "s", transcript_path: "", cwd: "/work/project",
    } as Parameters<typeof hook>[0], "toolu_9", { signal: new AbortController().signal });
    assert.deepEqual(hookOutput, {});
    const call = client.callTool({ name: "read", arguments: { path: "a.txt" } });
    pending.resolve("toolu_9", OK);
    assert.deepEqual(await call, OK);
});

test("an MCP call for a tool Pi did not offer fails without running anything", async (t) => {
    const { client } = await connect(t, [READ_TOOL]);
    await assert.rejects(client.callTool({ name: "bash", arguments: {} }), /unregistered Pi tool: mcp__pi__bash/);
});
