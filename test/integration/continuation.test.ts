import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY_TYPE } from "../../src/constants.js";
import {
    ACCOUNT_CHANGED, FORKED, HANDOFF, HISTORY_CHANGED, INVALID_STATE, NO_NEW_INPUT, TRANSCRIPT_LOST,
    TRANSCRIPT_MISSING,
} from "../../src/messages.js";
import { ACCOUNT_A, ACCOUNT_B } from "../fixtures/fake-claude.js";
import { Chat, CWD, eventually, PiHost, startPi, textOf, toolCallsOf } from "../fixtures/pi-host.js";

const texts = (content: unknown): string[] =>
    (content as { type: string; text?: string }[])
        .filter(block => block.type === "text")
        .map(block => block.text ?? "");

const foreignReply = (text: string): AssistantMessage => ({
    role: "assistant", api: "openai-responses", provider: "openai", model: "gpt", content: [{ type: "text", text }],
    usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp: Date.now(),
});

test("each turn appends continuation state without account identifiers or prompt text", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("secret question");
    await chat.ask("second question");
    const records = host.records;
    assert.deepEqual(records.map(record => record.revision), [1, 2]);
    const [first, second] = records;
    const child = fake.processes[0];
    assert.equal(first.version, 1);
    assert.equal(first.piSessionId, host.sessionManager.getSessionId());
    assert.equal(first.claudeSessionId, child.sessionId);
    assert.match(first.accountKey, /^[0-9a-f]{64}$/);
    assert.equal(first.failed, false);
    assert.equal(first.seen.count, 2);
    assert.deepEqual(first.good, { ...first.seen, claudeMessageId: child.assistantUuids[0] });
    assert.equal(second.seen.count, 4);
    assert.equal(second.good.claudeMessageId, child.assistantUuids[1]);
    const serialized = JSON.stringify(records);
    const secrets = [ACCOUNT_A.email, ACCOUNT_A.orgId, ACCOUNT_A.organization, "secret question", chat.systemPrompt];
    for (const secret of secrets) {
        assert.equal(serialized.includes(secret), false, secret);
    }
});

test("reload resumes the same Claude session and sends only the new message", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("first");
    const sessionId = fake.processes[0].sessionId;
    await host.reload();
    const run = await chat.ask("second");
    assert.equal(run.message.stopReason, "stop");
    const resumed = fake.sessionProcesses.at(-1);
    assert.equal(resumed?.flags.get("resume"), sessionId);
    assert.equal(resumed?.flags.has("session-id"), false);
    assert.equal(resumed?.userMessages.length, 1);
    assert.deepEqual(texts(resumed?.userMessages[0].message.content), ["second"]);
});

test("a Pi restart and session resume continue the stored Claude session", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("first");
    const sessionId = fake.processes[0].sessionId;
    await host.shutdown();
    PiHost.newProcess();
    const restarted = new PiHost(fake.io(), host.sessionManager);
    await restarted.start("resume");
    t.after(() => restarted.shutdown());
    const resumedChat = new Chat(restarted);
    resumedChat.messages.push(...chat.messages);
    const run = await resumedChat.ask("after restart");
    assert.equal(run.message.stopReason, "stop");
    const resumed = fake.sessionProcesses.at(-1);
    assert.equal(resumed?.flags.get("resume"), sessionId);
    assert.deepEqual(texts(resumed?.userMessages[0].message.content), ["after restart"]);
});

test("a completed tool turn survives reload without executing the tool again", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        if (turn.text === "read a.txt") {
            await turn.callTool("read", { path: "a.txt" });
            await turn.reply("read done");
        } else {
            await turn.reply(`follow-up: ${turn.text}`);
        }
    };
    const first = await chat.ask("read a.txt");
    const [call] = toolCallsOf(first.message);
    await chat.toolResult(call, "contents").send();
    await host.reload();
    const followUp = await chat.ask("summarize it");
    assert.equal(textOf(followUp.message), "follow-up: summarize it");
    assert.equal(fake.processes.reduce((sum, child) => sum + child.toolCalls.length, 0), 1);
    assert.deepEqual(texts(fake.sessionProcesses.at(-1)?.userMessages[0].message.content), ["summarize it"]);
});

test("a reload while a tool runs keeps Pi's result for the resumed session without re-running the tool", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        if (turn.text === "read a.txt") await turn.callTool("read", { path: "a.txt" });
        else await turn.reply("resumed with result");
    };
    const first = await chat.ask("read a.txt");
    const [call] = toolCallsOf(first.message);
    await host.reload();
    const next = await chat.toolResult(call, "contents").send();
    assert.equal(textOf(next.message), "resumed with result");
    const resumed = fake.sessionProcesses.at(-1);
    assert.equal(resumed?.flags.get("resume"), fake.processes[0].sessionId);
    assert.match(texts(resumed?.userMessages[0].message.content).join("\n"), /<tool-result>[\s\S]*contents/);
    assert.equal(fake.processes.reduce((sum, child) => sum + child.toolCalls.length, 0), 0);
});

test("a failed turn restarts at the last successful reply and resends the unseen messages", async (t) => {
    const { fake, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        if (turn.text === "fails") turn.finish({ is_error: true, result: "Internal failure", api_error_status: 500 });
        else await turn.reply(`ok: ${texts(turn.content).join(" | ")}`);
    };
    await chat.ask("works");
    const good = fake.processes[0].assistantUuids[0];
    const failed = await chat.ask("fails");
    assert.equal(failed.message.stopReason, "error");
    const retry = await chat.ask("retry");
    assert.equal(textOf(retry.message), "ok: fails | retry");
    const restarted = fake.sessionProcesses.at(-1);
    assert.equal(restarted?.flags.get("resume"), fake.processes[0].sessionId);
    assert.equal(restarted?.flags.get("resume-session-at"), good);
});

test("a prompt or tool change restarts Claude Code on the same session with the new declarations", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("first");
    const sessionId = fake.processes[0].sessionId;
    chat.systemPrompt = "You are Pi. A new extension changed this prompt.";
    await chat.ask("second");
    const promptRestart = fake.sessionProcesses.at(-1);
    assert.equal(fake.sessionProcesses.length, 2);
    assert.equal(promptRestart?.flags.get("resume"), sessionId);
    assert.match(promptRestart?.systemPrompt ?? "", /A new extension changed this prompt\./);
    chat.tools = [];
    await chat.ask("third");
    const toolRestart = fake.sessionProcesses.at(-1);
    assert.equal(fake.sessionProcesses.length, 3);
    assert.equal(toolRestart?.flags.get("resume"), sessionId);
    assert.equal(toolRestart?.initialize?.sdkMcpServers, undefined);
});

test("separate Pi sessions use separate Claude sessions and never see each other's prompts", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("private to session one");
    await host.switchSession("new", SessionManager.inMemory(CWD));
    await new Chat(host).ask("session two");
    const [one, two] = fake.sessionProcesses;
    assert.notEqual(one.sessionId, two.sessionId);
    assert.equal(two.flags.has("resume"), false);
    assert.deepEqual(two.userMessages.map(message => texts(message.message.content)), [["session two"]]);
});

test("edited history fails instead of silently diverging", async (t) => {
    const { chat } = await startPi(t);
    await chat.ask("original");
    chat.messages[0] = { role: "user", content: "edited", timestamp: Date.now() };
    const run = await chat.ask("next");
    assert.equal(run.message.errorMessage, HISTORY_CHANGED);
});

test("history from another provider cannot be taken over", async (t) => {
    const { fake, chat } = await startPi(t);
    chat.user("hello");
    chat.messages.push(foreignReply("from another provider"));
    assert.equal((await chat.ask("switch to Claude")).message.errorMessage, HANDOFF);
    assert.equal(fake.processes.length, 0);
});

test("a reply from another provider inside a Claude chat cannot be handed back", async (t) => {
    const { chat } = await startPi(t);
    await chat.ask("on Claude");
    chat.messages.push(foreignReply("switched away"));
    assert.equal((await chat.ask("back to Claude")).message.errorMessage, HANDOFF);
});

test("a forked session cannot continue the source session's Claude chat", async (t) => {
    const { host, chat } = await startPi(t);
    await chat.ask("before fork");
    const fork = SessionManager.inMemory(CWD);
    for (const record of host.records) fork.appendCustomEntry(STATE_ENTRY_TYPE, record);
    await host.switchSession("fork", fork);
    const forked = new Chat(host);
    forked.messages.push(...chat.messages);
    assert.equal((await forked.ask("after fork")).message.errorMessage, FORKED);
});

test("navigating back to an older branch revision fails instead of reusing newer native history", async (t) => {
    const { host, chat } = await startPi(t);
    await chat.ask("one");
    const firstEntry = host.sessionManager.getLeafId();
    await chat.ask("two");
    assert.ok(firstEntry);
    host.sessionManager.branch(firstEntry);
    chat.messages.splice(2);
    assert.equal((await chat.ask("alternate two")).message.errorMessage, HISTORY_CHANGED);
});

test("a missing Claude transcript fails instead of starting an empty chat", async (t) => {
    const { fake, host, chat } = await startPi(t);
    await chat.ask("first");
    await host.reload();
    fake.sessions.clear();
    const run = await chat.ask("second");
    assert.equal(run.message.errorMessage, TRANSCRIPT_MISSING);
    assert.equal(fake.userMessages.length, 1);
});

test("a transcript Claude Code could not save stops the chat from resuming", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        await turn.reply("ok");
        turn.emit({ type: "system", subtype: "session_writes_lost", error_code: "ENOSPC", lost: ["transcript"] });
    };
    assert.equal((await chat.ask("first")).message.stopReason, "stop");
    await eventually(() => host.warnings.length > 0);
    assert.deepEqual(host.warnings, [TRANSCRIPT_LOST]);
    assert.equal((await chat.ask("second")).message.errorMessage, TRANSCRIPT_LOST);
});

test("unreadable continuation state fails with an actionable error", async (t) => {
    const { host, chat } = await startPi(t);
    await chat.ask("first");
    host.sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, { version: 1, piSessionId: 7 });
    assert.equal((await chat.ask("second")).message.errorMessage, INVALID_STATE);
});

test("a request without new user input or tool results is rejected", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("first");
    assert.equal((await chat.send()).message.errorMessage, NO_NEW_INPUT);
    assert.equal(fake.userMessages.length, 1);
});

test("a login change fails the existing chat before Claude Code starts for the new account", async (t) => {
    const { fake, chat } = await startPi(t);
    await chat.ask("on account A");
    fake.login(ACCOUNT_B);
    const run = await chat.ask("on account B");
    assert.equal(run.message.errorMessage, ACCOUNT_CHANGED);
    assert.equal(fake.userMessages.length, 1);
    assert.equal(fake.processes.filter(child => child.persist).length, 1);
    await eventually(() => fake.running.length === 0);
});
