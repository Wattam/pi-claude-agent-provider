import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { PiStreamWriter } from "../../src/stream-writer.js";
import { SONNET } from "../fixtures/pi-host.js";

async function drain(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessageEvent[]> {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function writer(effort?: string) {
    const stream = createAssistantMessageEventStream();
    return { stream, writer: new PiStreamWriter(SONNET, stream, effort) };
}

test("text deltas build one message and end with exactly one done event", async () => {
    const { stream, writer: output } = writer("high");
    const index = output.textStart();
    output.textDelta(index, "Grüße, ");
    output.textDelta(index, "世界 👋🏽");
    output.textEnd(index);
    output.done("stop");
    output.done("stop");
    output.fail("error", "late failure");
    const events = await drain(stream);
    assert.deepEqual(events.map(event => event.type),
        ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    const message = await stream.result();
    assert.deepEqual(message.content, [{ type: "text", text: "Grüße, 世界 👋🏽" }]);
    assert.equal(message.stopReason, "stop");
    assert.equal(message.provider, "claude-agent");
    assert.equal(message.api, "claude-agent-sdk");
    assert.equal(message.model, "sonnet");
    assert.equal(message.providerThinkingLevel, "high");
    assert.equal(output.finished, true);
});

test("an empty successful reply completes with a start and one done event", async () => {
    const { stream, writer: output } = writer();
    output.done("stop");
    assert.deepEqual((await drain(stream)).map(event => event.type), ["start", "done"]);
    const message = await stream.result();
    assert.deepEqual(message.content, []);
    assert.equal(message.providerThinkingLevel, undefined);
});

test("thinking and tool-call blocks stream in order with final arguments", async () => {
    const { stream, writer: output } = writer();
    const thinking = output.thinkingStart();
    output.thinkingDelta(thinking, "consider");
    output.thinkingEnd(thinking);
    const call = output.toolCallStart("toolu_1", "read");
    output.toolCallDelta(call, "{\"path\":");
    output.toolCallDelta(call, "\"a.txt\"}");
    output.toolCallEnd(call, { arguments: { path: "a.txt" } });
    output.done("toolUse");
    const events = await drain(stream);
    assert.deepEqual(events.map(event => event.type), [
        "start", "thinking_start", "thinking_delta", "thinking_end",
        "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
    ]);
    const end = events.find(event => event.type === "toolcall_end");
    assert.deepEqual(end?.type === "toolcall_end" && end.toolCall,
        { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } });
    const message = await stream.result();
    assert.equal(message.stopReason, "toolUse");
    assert.equal(message.content[0].type, "thinking");
});

test("a failure is the only terminal event and keeps partial content as an error", async () => {
    const { stream, writer: output } = writer();
    const index = output.textStart();
    output.textDelta(index, "partial");
    output.fail("aborted", "Request was aborted");
    output.done("stop");
    const events = await drain(stream);
    assert.deepEqual(events.filter(event => event.type === "done" || event.type === "error").map(event => event.type),
        ["error"]);
    const message = await stream.result();
    assert.equal(message.stopReason, "aborted");
    assert.equal(message.errorMessage, "Request was aborted");
});
