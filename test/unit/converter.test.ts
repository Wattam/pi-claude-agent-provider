import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type Usage } from "@earendil-works/pi-ai";
import { ClaudeStreamConverter } from "../../src/converter.js";
import { AUTH_EXPIRED, billingError, incomplete, quotaExceeded, serverError } from "../../src/messages.js";
import { PiStreamWriter } from "../../src/stream-writer.js";
import { BASH_TOOL, READ_TOOL, SONNET } from "../fixtures/pi-host.js";

type Json = Record<string, unknown>;

const MODEL = "claude-sonnet-fixture";
const sdk = (message: Json, parent: string | null = null): SDKMessage =>
    ({ parent_tool_use_id: parent, uuid: randomUUID(), session_id: "claude-session", ...message }) as unknown as
        SDKMessage;
const event = (body: Json, parent: string | null = null): SDKMessage =>
    sdk({ type: "stream_event", event: body }, parent);
const start = (id: string, usage: Json = { input_tokens: 10, output_tokens: 1 }): SDKMessage =>
    event({ type: "message_start", message: { id, model: MODEL, content: [], usage } });
const blockStart = (index: number, block: Json): SDKMessage =>
    event({ type: "content_block_start", index, content_block: block });
const delta = (index: number, body: Json): SDKMessage => event({ type: "content_block_delta", index, delta: body });
const blockStop = (index: number): SDKMessage => event({ type: "content_block_stop", index });
const rateLimit = (info: Json): SDKMessage => sdk({ type: "rate_limit_event", rate_limit_info: info });
const assistantMessage = (id: string, content: Json[], extra: Json = {}): SDKMessage => sdk({
    type: "assistant", message: { id, model: MODEL, content, usage: { input_tokens: 10, output_tokens: 9 } }, ...extra,
});
const result = (fields: Json): SDKResultMessage => ({
    type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, duration_ms: 1, duration_api_ms: 1,
    stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {},
    permission_denials: [], uuid: randomUUID(), session_id: "claude-session", ...fields,
}) as unknown as SDKResultMessage;
const failed = (fields: Json): SDKResultMessage => result({ is_error: true, ...fields });

function summary(content: readonly unknown[]): Json[] {
    return (content as Json[]).map(block => block.type === "text" ? { type: "text", text: block.text }
        : block.type === "thinking" ? { type: "thinking", thinking: block.thinking }
            : { type: block.type, id: block.id, name: block.name, arguments: block.arguments });
}

const counts = (usage: Usage): number[] =>
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];

function setup() {
    const stream = createAssistantMessageEventStream();
    const writer = new PiStreamWriter(SONNET, stream, undefined);
    return { writer, converter: new ClaudeStreamConverter(writer, [READ_TOOL, BASH_TOOL], SONNET) };
}

function streamBlocks(converter: ClaudeStreamConverter, id: string): void {
    const messages = [
        start(id),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "thinking_delta", thinking: "plan" }),
        delta(0, { type: "signature_delta", signature: "sig" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "Hi " }),
        delta(1, { type: "text_delta", text: "🌍" }),
        blockStop(1),
        blockStart(2, { type: "tool_use", id: "toolu_1", name: "mcp__pi__read", input: {} }),
        delta(2, { type: "input_json_delta", partial_json: "{\"pa" }),
        delta(2, { type: "input_json_delta", partial_json: "th\":\"a\"}" }),
        blockStop(2),
        blockStart(3, { type: "tool_use", id: "toolu_x", name: "Bash", input: {} }),
        blockStop(3),
    ];
    for (const message of messages) converter.accept(message);
}

test("streamed thinking, text, and Pi tool calls become Pi content with Pi tool names", () => {
    const { writer, converter } = setup();
    streamBlocks(converter, "msg_1");
    const uuid = randomUUID();
    converter.accept(assistantMessage("msg_1", [
        { type: "thinking", thinking: "plan" }, { type: "text", text: "Hi 🌍" },
        { type: "tool_use", id: "toolu_1", name: "mcp__pi__read", input: { path: "a" } },
    ], { uuid }));
    assert.deepEqual(summary(writer.output.content), [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Hi 🌍" },
        { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } },
    ]);
    assert.deepEqual(converter.piToolCallIds, ["toolu_1"]);
    assert.equal(writer.output.responseModel, MODEL);
    assert.equal(writer.output.responseId, uuid);
    assert.equal(converter.lastAssistantUuid, uuid);
});

test("a new API message resets the Pi tool calls awaiting results", () => {
    const { converter } = setup();
    streamBlocks(converter, "msg_1");
    converter.accept(start("msg_2"));
    assert.deepEqual(converter.piToolCallIds, []);
});

test("subagent messages do not change the Pi output", () => {
    const { writer, converter } = setup();
    const parent = "toolu_parent";
    converter.accept(event({ type: "message_start", message: { id: "sub", model: "m", content: [], usage: {} } },
        parent));
    converter.accept(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "x" } },
        parent));
    converter.accept(assistantMessage("sub", [{ type: "text", text: "x" }], { parent_tool_use_id: parent }));
    assert.deepEqual(writer.output.content, []);
    assert.equal(converter.lastAssistantUuid, undefined);
});

test("an assistant message without stream events is synthesized once", () => {
    const { writer, converter } = setup();
    converter.accept(assistantMessage("msg_9", [
        { type: "text", text: "complete" },
        { type: "tool_use", id: "toolu_2", name: "mcp__pi__bash", input: { command: "ls" } },
        { type: "tool_use", id: "toolu_3", name: "WebSearch", input: {} },
    ]));
    assert.deepEqual(summary(writer.output.content), [
        { type: "text", text: "complete" },
        { type: "toolCall", id: "toolu_2", name: "bash", arguments: { command: "ls" } },
    ]);
});

test("a successful result is not a failure", () => {
    assert.equal(setup().converter.failure(result({ result: "done" })), undefined);
});

test("expired authentication maps to the login instruction", () => {
    const converter = setup().converter;
    converter.accept(assistantMessage("m", [], { error: "authentication_failed" }));
    const status = failed({ result: "Invalid API key · Please run /login", api_error_status: 401 });
    assert.equal(converter.failure(status), AUTH_EXPIRED);
});

test("quota exhaustion maps to the quota diagnostic with its window and reset", () => {
    const rejected = setup().converter;
    rejected.accept(rateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 }));
    assert.equal(rejected.failure(failed({ result: "limit reached", api_error_status: 429 })),
        quotaExceeded("five hour", 1_900_000_000));
    const coded = setup().converter;
    coded.accept(assistantMessage("m", [], { error: "rate_limit" }));
    assert.equal(coded.failure(failed({ result: "" })), quotaExceeded(undefined, undefined));
});

test("a quota failure never suggests paid credits or API billing as a fallback", () => {
    const text = quotaExceeded("seven day", undefined);
    assert.match(text, /does not fall back to paid credits or API billing/);
    assert.doesNotMatch(text, /Resets at/);
    assert.match(quotaExceeded(undefined, 1_900_000_000), new RegExp(new Date(1_900_000_000_000).toISOString()));
});

test("billing and server failures map to their diagnostics", () => {
    const billing = setup().converter;
    billing.accept(assistantMessage("m", [], { error: "billing_error" }));
    assert.equal(billing.failure(failed({ result: "Credit balance is too low" })),
        billingError("Credit balance is too low"));
    const emptyBilling = setup().converter;
    emptyBilling.accept(assistantMessage("m", [], { error: "billing_error" }));
    assert.equal(emptyBilling.failure(failed({ result: "" })), billingError("Claude reported a billing error."));
    assert.equal(setup().converter.failure(failed({ result: "overloaded", api_error_status: 529 })), serverError(529));
    assert.equal(setup().converter.failure(failed({ result: "oops", api_error_status: 500 })), serverError(500));
});

test("other failures keep Claude's text with the login hint rewritten for Pi", () => {
    const expired = failed({
        subtype: "error_during_execution", result: undefined, errors: ["Expired.", "Please run /login"],
    });
    assert.equal(setup().converter.failure(expired), "Expired.\nRun `claude auth login` in a terminal");
    const overflow = "Prompt is too long: 250000 tokens > 200000 maximum";
    assert.equal(setup().converter.failure(failed({ result: overflow, api_error_status: 400 })), overflow);
    const silent = failed({ subtype: "error_during_execution", errors: [] });
    assert.equal(setup().converter.failure(silent), incomplete(undefined));
    assert.equal(setup().converter.failure(failed({ result: "", api_error_status: 400 })), incomplete(400));
});

test("finishing usage writes deduplicated counts to the Pi message", () => {
    const { writer, converter } = setup();
    const usage = {
        input_tokens: 12, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 40, output_tokens: 30,
    };
    converter.accept(start("msg_1", { ...usage, output_tokens: 1 }));
    converter.accept(event({ type: "message_delta", delta: {}, usage: { output_tokens: 30 } }));
    converter.accept(assistantMessage("msg_1", [], { message: { id: "msg_1", model: "m", content: [], usage } }));
    const totals = {
        input_tokens: 99, output_tokens: 99, cache_read_input_tokens: 99, cache_creation_input_tokens: 99,
    };
    converter.accept(result({ usage: totals }));
    converter.finishUsage();
    assert.deepEqual(counts(writer.output.usage), [12, 30, 3_000, 40, 3_082]);
});
