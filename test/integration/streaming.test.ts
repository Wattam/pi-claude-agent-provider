import assert from "node:assert/strict";
import test from "node:test";
import { isContextOverflow, type Usage } from "@earendil-works/pi-ai";
import { toPiModel } from "../../src/catalog.js";
import { AUTH_EXPIRED, quotaExceeded } from "../../src/messages.js";
import { OPUS, startPi, terminalEvents, textOf, toolCallsOf } from "../fixtures/pi-host.js";

const UNICODE = "Grüße 👋🏽 世界 — ok";
const counts = (usage: Usage): number[] =>
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];

test("thinking and Unicode text stream through Pi's normal events with one terminal result", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.assistant([{ type: "thinking", thinking: "思考中" }, { type: "text", text: UNICODE }]);
    };
    const run = await chat.ask("hello", { reasoning: "medium" });
    const types = run.events.map(event => event.type);
    assert.equal(types[0], "start");
    for (const type of ["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end"]) {
        assert.ok(types.includes(type as never), type);
    }
    assert.ok(types.indexOf("thinking_end") < types.indexOf("text_start"));
    assert.equal(types.at(-1), "done");
    assert.equal(terminalEvents(run.events).length, 1);
    assert.equal(textOf(run.message), UNICODE);
    const thinking = run.message.content.find(block => block.type === "thinking");
    assert.equal(thinking?.type === "thinking" ? thinking.thinking : undefined, "思考中");
    assert.equal(run.message.stopReason, "stop");
});

test("an empty successful reply completes normally", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.reply("");
    };
    const run = await chat.ask("say nothing");
    assert.equal(run.message.stopReason, "stop");
    assert.deepEqual(run.message.content, []);
    assert.equal(terminalEvents(run.events).length, 1);
});

test("tool-call arguments stream as deltas and end with parsed arguments", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "docs/ü.md", limit: 10 });
    };
    const run = await chat.ask("read");
    const types = run.events.map(event => event.type);
    assert.ok(types.filter(type => type === "toolcall_delta").length >= 1);
    const end = run.events.find(event => event.type === "toolcall_end");
    const args = end?.type === "toolcall_end" ? end.toolCall.arguments : undefined;
    assert.deepEqual(args, { path: "docs/ü.md", limit: 10 });
    assert.deepEqual(toolCallsOf(run.message).map(call => call.name), ["read"]);
});

test("a max-tokens stop is reported as a length stop", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.reply("truncated", { stopReason: "max_tokens" });
        turn.finish({ stop_reason: "max_tokens" });
    };
    assert.equal((await chat.ask("long")).message.stopReason, "length");
});

test("cache writes, cache reads, and tool continuations are counted once per represented response", async (t) => {
    const { fake, chat } = await startPi(t);
    const usages = [
        { input_tokens: 20, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 0, output_tokens: 30 },
        { input_tokens: 25, cache_creation_input_tokens: 60, cache_read_input_tokens: 5_000, output_tokens: 12 },
        { input_tokens: 8, cache_creation_input_tokens: 40, cache_read_input_tokens: 5_060, output_tokens: 7 },
    ];
    fake.onTurn = async (turn) => {
        if (turn.text === "first") {
            await turn.reply("one", { usage: usages[0] });
        } else {
            await turn.callTools([{ name: "read", input: { path: "a" } }], { usage: usages[1] });
            await turn.reply("two", { usage: usages[2] });
        }
    };
    const first = (await chat.ask("first")).message.usage;
    assert.deepEqual(counts(first), [20, 30, 0, 5_000, 5_050]);
    const toolTurn = await chat.ask("second");
    const second = toolTurn.message.usage;
    assert.deepEqual([second.input, second.output, second.cacheRead, second.cacheWrite], [25, 12, 5_000, 60]);
    const [call] = toolCallsOf(toolTurn.message);
    const third = (await chat.toolResult(call, "body").send()).message.usage;
    assert.deepEqual(counts(third), [8, 7, 5_060, 40, 5_115]);
    assert.equal(third.cost.total, 0);
});

test("Pi's thinking level selects the SDK effort and later changes apply to the live session", async (t) => {
    const { fake, chat } = await startPi(t);
    const run = await chat.ask("one", { reasoning: "high" });
    assert.equal(run.message.providerThinkingLevel, "high");
    const child = fake.processes[0];
    assert.equal(child.flags.get("effort"), "high");
    assert.equal(child.flags.get("thinking"), "adaptive");
    assert.equal(child.flags.get("model"), "sonnet");
    await chat.ask("two", { reasoning: "low" });
    await chat.ask("three");
    assert.deepEqual(child.requests("apply_flag_settings").map(request => request.settings),
        [{ effortLevel: "low" }, { effortLevel: null }]);
    assert.equal(fake.sessionProcesses.length, 1);
});

test("selecting another Claude model switches the live session without restarting it", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("one", { reasoning: "high" });
    chat.model = OPUS;
    await chat.ask("two", { reasoning: "high" });
    const child = fake.processes[0];
    assert.deepEqual(child.requests("set_model").map(request => request.model), ["opus"]);
    assert.equal(child.model, "opus");
    assert.equal(fake.sessionProcesses.length, 1);
});

test("a model without effort levels launches with thinking disabled and no effort", async (t) => {
    const { fake, chat } = await startPi(t);
    chat.model = toPiModel({ id: "haiku", name: "Haiku", efforts: [] });
    await chat.ask("hello", { reasoning: "high" });
    const child = fake.processes[0];
    assert.equal(child.flags.get("thinking"), "disabled");
    assert.equal(child.flags.has("effort"), false);
    assert.equal(child.flags.get("model"), "haiku");
});

test("expired authentication ends the stream with the login instruction", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        turn.emit({ type: "assistant", error: "authentication_failed", message: {
            id: "msg_err", type: "message", role: "assistant", model: "sonnet",
            content: [{ type: "text", text: "Invalid API key · Please run /login" }],
            usage: { input_tokens: 0, output_tokens: 0 },
        } });
        turn.finish({ is_error: true, result: "Invalid API key · Please run /login", api_error_status: 401 });
    };
    const run = await chat.ask("hello");
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, AUTH_EXPIRED);
    assert.equal(terminalEvents(run.events).length, 1);
});

test("quota exhaustion surfaces once without retries, credit activation, or another billing route", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        const info = { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_900_000_000 };
        turn.emit({ type: "rate_limit_event", rate_limit_info: info });
        turn.finish({ is_error: true, result: "Claude usage limit reached", api_error_status: 429 });
    };
    const run = await chat.ask("hello");
    assert.equal(run.message.errorMessage, quotaExceeded("seven day", 1_900_000_000));
    assert.equal(fake.userMessages.length, 1);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.processes[0].options.env.ANTHROPIC_API_KEY, undefined);
});

test("context overflow fails visibly with Pi-detectable overflow text and no compaction", async (t) => {
    const { fake, chat } = await startPi(t);
    const overflow = "Prompt is too long: 250000 tokens > 200000 maximum";
    fake.onTurn = async (turn) => {
        turn.finish({ is_error: true, result: overflow, api_error_status: 400 });
    };
    const run = await chat.ask("huge");
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, overflow);
    assert.equal(isContextOverflow(run.message, chat.model.contextWindow), true);
    assert.equal(fake.userMessages.length, 1);
    assert.equal(fake.processes[0].options.env.DISABLE_AUTO_COMPACT, "1");
});

test("a Claude process that dies mid-reply ends the stream with one error", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        turn.streamEvent({ type: "message_start", message: {
            id: "msg_1", type: "message", role: "assistant", model: "sonnet", content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
        } });
        turn.streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        turn.streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
        await new Promise(resolve => setImmediate(resolve));
        turn.process.kill("SIGKILL");
    };
    const run = await chat.ask("hello");
    assert.equal(run.message.stopReason, "error");
    assert.ok(run.message.errorMessage);
    assert.equal(terminalEvents(run.events).length, 1);
});
