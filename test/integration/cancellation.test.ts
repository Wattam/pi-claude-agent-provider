import assert from "node:assert/strict";
import test from "node:test";
import { ABORTED } from "../../src/messages.js";
import type { FakeTurn } from "../fixtures/fake-claude.js";
import { eventually, startPi, terminalEvents, textOf, toolCallsOf } from "../fixtures/pi-host.js";

async function partialThenWait(turn: FakeTurn): Promise<void> {
    turn.streamEvent({ type: "message_start", message: {
        id: "msg_partial", type: "message", role: "assistant", model: "sonnet", content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
    } });
    turn.streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    turn.streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
    await turn.untilAborted();
}

test("cancelling during generation interrupts Claude and ends the stream as aborted", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = partialThenWait;
    const controller = new AbortController();
    const done = chat.user("long task").start({ signal: controller.signal }, (event) => {
        if (event.type === "text_delta") controller.abort();
    });
    const run = await done;
    assert.equal(run.message.stopReason, "aborted");
    assert.equal(run.message.errorMessage, ABORTED);
    assert.equal(terminalEvents(run.events).length, 1);
    assert.equal(fake.processes[0].requests("interrupt").length, 1);
    assert.equal(fake.processes[0].turns[0].finished, true);
});

test("a prompt after a cancellation continues the same Claude session without resending history", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = partialThenWait;
    const controller = new AbortController();
    const done = chat.user("long task").start({ signal: controller.signal }, (event) => {
        if (event.type === "text_delta") controller.abort();
    });
    await done;
    fake.onTurn = async (turn) => {
        await turn.reply(`continuing after: ${turn.text}`);
    };
    const next = await chat.ask("shorter task");
    assert.equal(next.message.stopReason, "stop");
    assert.equal(textOf(next.message), "continuing after: shorter task");
    assert.equal(fake.processes.length, 1);
    assert.deepEqual(fake.userMessages.at(-1)?.message.content, [{ type: "text", text: "shorter task" }]);
});

test("cancelling at a Pi tool boundary drains the turn before the next request runs", async (t) => {
    const { fake, chat } = await startPi(t);
    let finishAborted!: () => void;
    const held = new Promise<void>((resolve) => {
        finishAborted = resolve;
    });
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "a.txt" }).catch(() => undefined);
        await held;
    };
    const controller = new AbortController();
    const run = await chat.user("read it").start({ signal: controller.signal }, (event) => {
        if (event.type === "toolcall_start") controller.abort();
    });
    assert.equal(run.message.stopReason, "aborted");
    const child = fake.processes[0];
    assert.equal(child.turns[0].finished, false);
    fake.onTurn = async (turn) => {
        await turn.reply("continued");
    };
    const next = chat.ask("try again");
    finishAborted();
    const result = await next;
    assert.equal(result.message.stopReason, "stop");
    assert.equal(textOf(result.message), "continued");
    assert.equal(child.toolCalls.length, 0);
    assert.equal(fake.processes.length, 1);
    assert.equal(child.turns.length, 2);
});

test("settling the agent interrupts a parked tool turn without executing the tool", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "a.txt" });
        await turn.reply("should not continue");
    };
    const first = await chat.ask("read it");
    assert.equal(first.message.stopReason, "toolUse");
    await host.emit("agent_settled", {});
    const child = fake.processes[0];
    assert.equal(child.requests("interrupt").length, 1);
    await eventually(() => child.turns[0].finished);
    assert.equal(child.turns[0].signal.aborted, true);
    assert.equal(child.toolCalls.length, 0);
    const [call] = toolCallsOf(first.message);
    fake.onTurn = async (turn) => {
        await turn.reply(turn.text.includes("<conversation-checkpoint>") ? "caught up" : "missing history");
    };
    const next = await chat.toolResult(call, "Tool execution was aborted", true).user("try something else").send();
    assert.equal(textOf(next.message), "caught up");
    assert.equal(fake.processes.length, 1);
    assert.equal(child.turns.length, 2);
    assert.match(child.turns[1].text, /Tool execution was aborted[\s\S]*try something else/);
});

test("settling with no parked turn sends no interrupt", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("hello");
    await host.emit("agent_settled", {});
    assert.equal(fake.processes[0].requests("interrupt").length, 0);
});
