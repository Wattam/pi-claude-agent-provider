import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_FAILED } from "../../src/messages.js";
import type { FakeTurn } from "../fixtures/fake-claude.js";
import { BASH_TOOL, READ_TOOL, startPi, terminalEvents, textOf, toolCallsOf } from "../fixtures/pi-host.js";

const textResult = (result: CallToolResult): string =>
    result.content.map(block => block.type === "text" ? block.text : "").join("");

async function readThenAnswer(turn: FakeTurn): Promise<void> {
    const result = await turn.callTool("read", { path: "a.txt" }, "toolu_read_1");
    await turn.reply(`${result.isError ? "error" : "saw"}: ${textResult(result)}`);
}

test("only Pi's currently offered tools are listed through the private bridge", async (t) => {
    const { fake, chat } = await startPi(t);
    chat.tools = [READ_TOOL, BASH_TOOL];
    await chat.ask("hello");
    const child = fake.processes[0];
    assert.deepEqual(child.listedTools.map(tool => tool.name), ["read", "bash"]);
    assert.deepEqual(child.listedTools[0].inputSchema, JSON.parse(JSON.stringify(READ_TOOL.parameters)));
});

test("a Pi tool call ends the Pi stream with toolUse and resumes Claude with Pi's result once", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = readThenAnswer;
    const first = await chat.ask("read a.txt");
    assert.equal(first.message.stopReason, "toolUse");
    assert.equal(terminalEvents(first.events).length, 1);
    const [call] = toolCallsOf(first.message);
    assert.deepEqual({ id: call.id, name: call.name, arguments: call.arguments },
        { id: "toolu_read_1", name: "read", arguments: { path: "a.txt" } });
    const second = await chat.toolResult(call, "file body").send();
    assert.equal(second.message.stopReason, "stop");
    assert.equal(textOf(second.message), "saw: file body");
    const child = fake.processes[0];
    assert.deepEqual(child.toolCalls.map(record => [record.id, record.name, record.result]),
        [["toolu_read_1", "read", { isError: false, content: [{ type: "text", text: "file body" }] }]]);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.userMessages.length, 1);
});

test("a tool result rejected by a Pi hook reaches Claude as Pi's error result without fallback tools", async (t) => {
    const { fake, chat } = await startPi(t);
    chat.tools = [BASH_TOOL];
    fake.onTurn = async (turn) => {
        const result = await turn.callTool("bash", { command: "rm -rf /" }, "toolu_bash_1");
        await turn.reply(`${result.isError ? "blocked" : "ran"}: ${textResult(result)}`);
    };
    const first = await chat.ask("clean up");
    const [call] = toolCallsOf(first.message);
    const second = await chat.toolResult(call, "Blocked by policy hook", true).send();
    assert.equal(textOf(second.message), "blocked: Blocked by policy hook");
    assert.equal(fake.processes[0].toolCalls.length, 1);
    assert.equal(fake.processes[0].toolCalls[0].result.isError, true);
    assert.equal(fake.processes[0].flags.get("tools"), "");
});

test("several tool calls in one reply are answered in one continuation", async (t) => {
    const { fake, chat } = await startPi(t);
    chat.tools = [READ_TOOL, BASH_TOOL];
    fake.onTurn = async (turn) => {
        const results = await turn.callTools([
            { name: "read", input: { path: "a" }, id: "toolu_a" },
            { name: "bash", input: { command: "ls" }, id: "toolu_b" },
        ]);
        await turn.reply(results.map(textResult).join("+"));
    };
    const first = await chat.ask("do both");
    const calls = toolCallsOf(first.message);
    assert.deepEqual(calls.map(call => call.id), ["toolu_a", "toolu_b"]);
    const second = await chat.toolResult(calls[0], "A").toolResult(calls[1], "B").send();
    assert.equal(textOf(second.message), "A+B");
});

test("a user message added after tool results is delivered into the same Claude turn", async (t) => {
    const { fake, chat } = await startPi(t);
    let steering: string[] = [];
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "a.txt" });
        steering = turn.injected.map(message => JSON.stringify(message.message.content));
        await turn.reply("continued");
    };
    const first = await chat.ask("read");
    const [call] = toolCallsOf(first.message);
    const second = await chat.toolResult(call, "body").user("also check b.txt").send();
    assert.equal(textOf(second.message), "continued");
    assert.equal(steering.length, 1);
    assert.match(steering[0], /also check b\.txt/);
    assert.equal(fake.processes[0].turns.length, 1);
});

test("a bridge that does not connect fails the request", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.bridgeStatus = "failed";
    const run = await chat.ask("hello");
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, BRIDGE_FAILED);
});

test("a request with tool choice none offers Claude no tools", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("hello", { toolChoice: "none" });
    const child = fake.processes[0];
    assert.equal(child.initialize?.sdkMcpServers, undefined);
    assert.deepEqual(child.listedTools, []);
});
