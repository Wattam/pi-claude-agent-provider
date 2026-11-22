import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { IDLE_STOP_MS } from "../../src/constants.js";
import { STANDALONE } from "../../src/messages.js";
import { FakeClaude } from "../fixtures/fake-claude.js";
import {
    captureTimers, eventually, PiHost, SONNET, startPi, terminalEvents, toolCallsOf,
} from "../fixtures/pi-host.js";

test("the factory registers one Claude Agent provider without starting processes or timers", (t) => {
    const fake = new FakeClaude();
    const timeout = t.mock.method(globalThis, "setTimeout");
    const interval = t.mock.method(globalThis, "setInterval");
    const host = new PiHost(fake.io());
    host.load();
    assert.equal(timeout.mock.callCount(), 0);
    assert.equal(interval.mock.callCount(), 0);
    assert.equal(fake.processes.length, 0);
    assert.equal(fake.authStatusCalls, 0);
    assert.equal(host.providerRegistrations, 1);
    assert.equal(host.provider.id, "claude-agent");
    assert.equal(host.provider.name, "Claude Agent");
    assert.deepEqual(host.provider.getModels(), []);
    for (const event of ["session_start", "session_shutdown", "agent_settled", "cache_warming_decision"]) {
        assert.equal(host.handlerCount(event), 1, event);
    }
});

test("provider auth supplies no credential and offers no separate login", async () => {
    const host = new PiHost(new FakeClaude().io());
    host.load();
    const auth = host.provider.auth.apiKey;
    assert.ok(auth);
    assert.equal(auth.login, undefined);
    const resolved = await (auth as unknown as { resolve(input: unknown): Promise<{ auth: unknown }> }).resolve({});
    assert.deepEqual(resolved.auth, {});
});

test("standalone calls such as session naming fail without starting Claude Code", async (t) => {
    const { fake, host } = await startPi(t);
    const context = normalizeContext({ systemPrompt: "Name this session", messages: [
        { role: "user", content: "Summarize the chat", timestamp: 1 },
    ] });
    for (const sessionId of [undefined, "another-session"]) {
        const stream = host.provider.streamSimple(SONNET, context, sessionId ? { sessionId } : {});
        const message = await stream.result();
        assert.equal(message.stopReason, "error");
        assert.equal(message.errorMessage, STANDALONE);
    }
    assert.equal(fake.processes.length, 0);
    assert.equal(fake.authStatusCalls, 0);
});

test("a standalone call during an active chat leaves the chat's state untouched", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("first");
    const records = host.records.length;
    const context = normalizeContext({ systemPrompt: "Summarize", messages: [
        { role: "user", content: "Summarize the chat", timestamp: 1 },
    ] });
    const message = await host.provider.streamSimple(SONNET, context, { sessionId: "naming-call" }).result();
    assert.equal(message.errorMessage, STANDALONE);
    assert.equal(host.records.length, records);
    assert.equal(fake.userMessages.length, 1);
    const next = await chat.ask("second");
    assert.equal(next.message.stopReason, "stop");
    assert.equal(fake.sessionProcesses.length, 1);
});

test("cache warming stops for Claude Agent and is left to Pi for other providers", async (t) => {
    const { host } = await startPi(t);
    assert.deepEqual(await host.emit("cache_warming_decision", { action: "warm" }, SONNET), [{ action: "stop" }]);
    const other = { ...SONNET, provider: "anthropic" };
    assert.deepEqual(await host.emit("cache_warming_decision", { action: "warm" }, other),
        [undefined]);
});

test("an idle Claude process stops after the idle period and the next prompt resumes it", async (t) => {
    const timers = captureTimers(t, IDLE_STOP_MS);
    const { fake, chat } = await startPi(t);
    const first = await chat.ask("hello");
    assert.equal(first.message.stopReason, "stop");
    assert.equal(fake.running.length, 1);
    await eventually(() => timers.active().length === 1);
    timers.fire();
    await eventually(() => fake.running.length === 0);
    const sessionId = fake.processes[0].sessionId;
    const second = await chat.ask("again");
    assert.equal(second.message.stopReason, "stop");
    const resumed = fake.sessionProcesses.at(-1);
    assert.equal(resumed?.flags.get("resume"), sessionId);
    assert.equal(resumed?.userMessages.length, 1);
});

test("a parked tool turn arms no idle stop", async (t) => {
    const timers = captureTimers(t, IDLE_STOP_MS);
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "a.txt" });
        await turn.reply("done");
    };
    const run = await chat.ask("read it");
    assert.equal(run.message.stopReason, "toolUse");
    assert.equal(toolCallsOf(run.message).length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.active().length, 0);
});

test("session shutdown stops the Claude process and later shutdowns are harmless", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("hello");
    assert.equal(fake.running.length, 1);
    await host.shutdown();
    await eventually(() => fake.running.length === 0);
    await host.shutdown();
});

test("shutdown of a parked tool turn completes when Claude rejects the interrupt", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.callTool("read", { path: "a.txt" });
        await turn.untilAborted();
    };
    const run = await chat.ask("read it");
    assert.equal(run.message.stopReason, "toolUse");
    fake.interruptFailure = new Error("Interrupt rejected");
    await host.shutdown();
    await eventually(() => fake.running.length === 0);
    await host.shutdown();
});

test("reload replaces the runtime and keeps exactly one terminal event per request", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const first = await chat.ask("hello");
    await host.reload();
    await eventually(() => fake.running.length === 0);
    const second = await chat.ask("after reload");
    assert.equal(terminalEvents(first.events).length, 1);
    assert.equal(terminalEvents(second.events).length, 1);
    assert.equal(second.message.stopReason, "stop");
});
