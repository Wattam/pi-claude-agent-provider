import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { INTERRUPT_TIMEOUT_MS } from "../../src/constants.js";
import { extraUsageBlocked, extraUsageStopped, extraUsageWarning } from "../../src/messages.js";
import { ACCOUNT_B, type FakeClaude } from "../fixtures/fake-claude.js";
import {
    captureTimers, Chat, CWD, eventually, PiHost, startPi, terminalEvents, toolCallsOf,
} from "../fixtures/pi-host.js";

type Json = Record<string, unknown>;

/** Makes each turn start a reply, report `info`, and wait until the provider interrupts it. */
function reportOnTurn(fake: FakeClaude, info: Json): void {
    fake.onTurn = async (turn) => {
        turn.streamEvent({ type: "message_start", message: {
            id: "msg_1", type: "message", role: "assistant", model: "sonnet", content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
        } });
        turn.emit({ type: "rate_limit_event", rate_limit_info: info });
        await turn.untilAborted();
    };
}

const replyOk = (fake: FakeClaude): void => {
    fake.onTurn = async turn => {
        await turn.reply("ok");
    };
};

const future = (): number => Math.floor(Date.now() / 1000) + 3600;

test("requests run without a paid-usage lookup even when extra usage is enabled", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async (turn) => {
        turn.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageEnabled: true } });
        await turn.reply("ok");
    };
    assert.equal((await chat.ask("first")).message.stopReason, "stop");
    assert.equal((await chat.ask("second")).message.stopReason, "stop");
    assert.equal(fake.userMessages.length, 2);
    assert.deepEqual(fake.processes.flatMap(child => child.requests("get_usage")), []);
    assert.deepEqual(host.notifications, []);
});

test("a request reported as using extra usage is interrupted, fails the chat, and warns", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    reportOnTurn(fake, { status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true });
    const run = await chat.ask("hello");
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    assert.equal(fake.processes[0].requests("interrupt").length, 1);
    await eventually(() => fake.running.length === 0);
    assert.equal(host.records.at(-1)?.failed, true);
});

test("a rejected initial extra-usage interrupt closes the process and releases shutdown", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.interruptFailure = new Error("Initial interrupt rejected");
    reportOnTurn(fake, { status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true });
    const done = chat.ask("hello");
    await eventually(() => fake.processes.length > 0 && fake.running.length === 0);
    const run = await done;
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
    assert.equal(terminalEvents(run.events).length, 1);
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    assert.equal(host.records.at(-1)?.failed, true);
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
    assert.equal(fake.processes.length, 1);
    await host.shutdown();
});

for (const acknowledge of [false, true]) {
    test(`a stalled extra-usage interrupt forces process close (acknowledged=${acknowledge})`, async (t) => {
        const timers = captureTimers(t, INTERRUPT_TIMEOUT_MS);
        const { fake, host, chat } = await startPi(t);
        fake.onInterrupt = async turn => {
            if (!acknowledge) await turn?.untilAborted();
        };
        reportOnTurn(fake, { status: "allowed", overageInUse: true });
        const done = chat.ask("hello");
        await eventually(() => fake.processes[0]?.requests("interrupt").length === 1 && timers.active().length === 1);
        timers.fire();
        await eventually(() => fake.running.length === 0);
        const run = await done;
        assert.equal(run.message.errorMessage, extraUsageStopped(undefined));
        assert.equal(terminalEvents(run.events).length, 1);
        assert.deepEqual(host.warnings, [extraUsageWarning()]);
        assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(undefined));
        await host.shutdown();
    });
}

for (const cleanup of ["settle", "cancel", "reload"] as const) {
    test(`extra usage after a tool boundary is observed during ${cleanup}`, async (t) => {
        const { fake, host, chat } = await startPi(t);
        const resetsAt = future();
        const weeklyReset = resetsAt + 86_400;
        let report!: () => void;
        const ready = new Promise<void>(resolve => { report = resolve; });
        fake.onTurn = async turn => {
            const tool = turn.callTool("read", { path: "a.txt" }, "toolu_1").catch(() => undefined);
            await ready;
            if (cleanup !== "cancel") await turn.untilAborted();
            turn.emit({ type: "rate_limit_event", rate_limit_info: {
                status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true,
            } });
            await turn.untilAborted();
            turn.emit({ type: "rate_limit_event", rate_limit_info: {
                status: "allowed", rateLimitType: "seven_day", resetsAt: weeklyReset, overageInUse: true,
            } });
            await tool;
        };
        const controller = new AbortController();
        const first = await chat.ask("read it", { signal: controller.signal });
        assert.equal(first.message.stopReason, "toolUse");
        if (cleanup === "cancel") controller.abort();
        report();
        if (cleanup === "reload") await host.reload();
        else if (cleanup === "settle") await host.emit("agent_settled", {});
        await eventually(() => fake.running.length === 0);
        assert.deepEqual(host.warnings, [extraUsageWarning()]);
        assert.equal(host.records.at(-1)?.failed, true);
        assert.deepEqual(fake.processes[0].toolCalls, []);
        const [call] = toolCallsOf(first.message);
        const next = await chat.toolResult(call, "Cancelled", true).user("try again").send();
        assert.equal(next.message.errorMessage, extraUsageBlocked(weeklyReset));
        assert.equal(fake.userMessages.length, 1);
        assert.equal(fake.processes.length, 1);
        await host.reload();
        assert.equal((await chat.ask("after reload")).message.errorMessage, extraUsageBlocked(weeklyReset));
    });
}

for (const stalledInterrupt of [false, true]) {
    test(`extra usage stops queued inference (stalled interrupt=${stalledInterrupt})`, async (t) => {
        const { fake, host, chat } = await startPi(t);
        const resetsAt = future();
        const timers = captureTimers(t, INTERRUPT_TIMEOUT_MS);
        fake.queueAdditionalInput = true;
        if (stalledInterrupt) fake.onInterrupt = async turn => { await turn?.untilAborted(); };
        fake.onTurn = async turn => {
            if (turn.text !== "read it") {
                await turn.reply("Unexpected billed turn");
                return;
            }
            await turn.callTool("read", { path: "a.txt" });
            // The CLI has accepted the extra prompt but has not folded it into this turn.
            await eventually(() => turn.process.userMessages.length === 2);
            turn.emit({ type: "rate_limit_event", rate_limit_info: {
                status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true,
            } });
            await turn.untilAborted();
        };
        const first = await chat.ask("read it");
        const [call] = toolCallsOf(first.message);
        const done = chat.toolResult(call, "file contents").user("also check b.txt").send();
        try {
            await eventually(() => fake.running.length === 0);
        } finally {
            timers.fire();
        }
        const next = await done;
        const child = fake.processes[0];
        assert.equal(child.userMessages.length, 2, "the regression must exercise accepted queued input");
        assert.equal(child.turns.length, 1, "queued input must never start another native turn");
        assert.equal(next.message.stopReason, "error");
        assert.equal(next.message.errorMessage, extraUsageStopped(resetsAt));
        assert.equal(terminalEvents(next.events).length, 1);
        assert.deepEqual(host.warnings, [extraUsageWarning()]);
        assert.equal(host.records.at(-1)?.failed, true);
        assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
        await host.reload();
        assert.equal((await chat.ask("after reload")).message.errorMessage, extraUsageBlocked(resetsAt));
        assert.equal(fake.processes.length, 1);
    });
}

test("subscription reset evidence survives a Pi tool continuation", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.onTurn = async turn => {
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "rejected", rateLimitType: "five_hour", resetsAt,
        } });
        await turn.callTool("read", { path: "a.txt" });
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "allowed", rateLimitType: "overage", resetsAt: resetsAt + 3600, overageInUse: true,
        } });
        await turn.untilAborted();
    };
    const first = await chat.ask("read it");
    const [call] = toolCallsOf(first.message);
    const next = await chat.toolResult(call, "file contents").send();
    assert.equal(next.message.errorMessage, extraUsageStopped(resetsAt));
    assert.equal(terminalEvents(next.events).length, 1);
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    assert.equal(fake.userMessages.length, 1);
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
});

test("a report received during a payload hook blocks delivery of tool results", async (t) => {
    const { fake, host, chat } = await startPi(t);
    let report!: () => void;
    const ready = new Promise<void>(resolve => { report = resolve; });
    fake.onTurn = async turn => {
        const tool = turn.callTool("read", { path: "a.txt" }).catch(() => undefined);
        await ready;
        turn.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
        await turn.untilAborted();
        await tool;
    };
    const first = await chat.ask("read it");
    const [call] = toolCallsOf(first.message);
    const next = await chat.toolResult(call, "file contents").send({ onPayload: async () => {
        report();
        await eventually(() => host.warnings.length === 1);
    } });
    assert.equal(next.message.errorMessage, extraUsageStopped(undefined));
    assert.deepEqual(fake.processes[0].toolCalls, []);
    assert.equal(fake.userMessages.length, 1);
});

test("a report discovered while replacing a parked process blocks the replacement", async (t) => {
    const { fake, host, chat } = await startPi(t);
    fake.onTurn = async turn => {
        await turn.callTool("read", { path: "a.txt" }).catch(() => undefined);
        turn.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
    };
    assert.equal((await chat.ask("read it")).message.stopReason, "toolUse");
    chat.systemPrompt += " New instruction.";
    const next = await chat.ask("try something else");
    assert.equal(next.message.errorMessage, extraUsageBlocked(undefined));
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.userMessages.length, 1);
});

test("an exhausted subscription reset reported before extra usage expires the account block", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.onTurn = async turn => {
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "rejected", rateLimitType: "five_hour", resetsAt,
        } });
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "allowed", rateLimitType: "overage", resetsAt: resetsAt + 3600, overageInUse: true,
        } });
        await turn.untilAborted();
    };
    const run = await chat.ask("first");
    assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
    replyOk(fake);
    await host.reload();
    assert.equal((await chat.ask("before reset")).message.errorMessage, extraUsageBlocked(resetsAt));
    assert.equal(fake.processes.length, 1, "blocked requests must not start Claude Code");
    t.mock.timers.enable({ apis: ["Date"], now: resetsAt * 1000 });
    const resumed = await chat.ask("after reset");
    t.mock.timers.reset();
    assert.equal(resumed.message.stopReason, "stop");
    assert.equal(fake.userMessages.length, 2);
});

for (const weeklyFirst of [false, true]) {
    test(`requests stay blocked until all exhausted windows reset (weekly first=${weeklyFirst})`, async (t) => {
        const { fake, host, chat } = await startPi(t);
        const hourlyReset = future();
        const weeklyReset = hourlyReset + 86_400;
        const reports = [
            { status: "allowed", rateLimitType: "five_hour", resetsAt: hourlyReset, isUsingOverage: true },
            { status: "allowed", rateLimitType: "seven_day", resetsAt: weeklyReset, overageInUse: true },
        ];
        if (weeklyFirst) reports.reverse();
        fake.onTurn = async turn => {
            turn.emit({ type: "rate_limit_event", rate_limit_info: reports[0] });
            await turn.untilAborted();
            turn.emit({ type: "rate_limit_event", rate_limit_info: reports[1] });
        };
        const stopped = await chat.ask("first");
        assert.equal(stopped.message.errorMessage, extraUsageStopped(weeklyReset));
        assert.deepEqual(host.warnings, [extraUsageWarning()]);
        assert.equal(fake.processes[0].requests("interrupt").length, 1);
        replyOk(fake);
        await host.reload();
        t.mock.timers.enable({ apis: ["Date"], now: hourlyReset * 1000 });
        assert.equal((await chat.ask("after hourly reset")).message.errorMessage, extraUsageBlocked(weeklyReset));
        assert.equal(fake.processes.length, 1, "the earlier reset must not start another Claude Code process");
        t.mock.timers.setTime(weeklyReset * 1000 - 1);
        assert.equal((await chat.ask("before weekly reset")).message.errorMessage, extraUsageBlocked(weeklyReset));
        t.mock.timers.setTime(weeklyReset * 1000);
        assert.equal((await chat.ask("after weekly reset")).message.stopReason, "stop");
        t.mock.timers.reset();
        assert.equal(fake.userMessages.length, 2);
    });
}

for (const missingWeeklyReset of [false, true]) {
    test(`unrelated resets cannot end an extra-usage block (missing weekly reset=${missingWeeklyReset})`, async (t) => {
        const { fake, host, chat } = await startPi(t);
        const resetsAt = future();
        fake.onTurn = async turn => {
            turn.emit({ type: "rate_limit_event", rate_limit_info: {
                status: "allowed", rateLimitType: "five_hour", resetsAt,
                ...(missingWeeklyReset ? { isUsingOverage: true } : { utilization: 0.2 }),
            } });
            if (missingWeeklyReset) await turn.untilAborted();
            turn.emit({ type: "rate_limit_event", rate_limit_info: {
                status: "allowed", rateLimitType: missingWeeklyReset ? "seven_day" : "overage", overageInUse: true,
                ...(missingWeeklyReset ? {} : { resetsAt: resetsAt + 3600 }),
            } });
            await turn.untilAborted();
        };
        assert.equal((await chat.ask("first")).message.errorMessage, extraUsageStopped(undefined));
        replyOk(fake);
        await host.reload();
        t.mock.timers.enable({ apis: ["Date"], now: (resetsAt + 604_800) * 1000 });
        assert.equal((await chat.ask("after unrelated resets")).message.errorMessage, extraUsageBlocked(undefined));
        t.mock.timers.reset();
        assert.equal(fake.processes.length, 1, "an unknown exhausted reset must block before Claude Code starts");
        assert.equal(fake.userMessages.length, 1);
    });
}

test("extra usage stops once when a tool boundary arrives during interruption", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.onTurn = async turn => {
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true,
        } });
        await turn.untilAborted();
        await turn.assistant([{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } }]);
    };
    const run = await chat.ask("hello");
    // Wait for cleanup after the terminal event so a second warning cannot arrive after the assertion.
    await host.emit("agent_settled", {});
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
    assert.equal(terminalEvents(run.events).length, 1);
    assert.equal(fake.processes[0].requests("interrupt").length, 1);
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    await eventually(() => fake.running.length === 0);
    assert.deepEqual(fake.processes[0].toolCalls, []);
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
});

for (const rateLimitType of [undefined, "overage"]) {
    test(`a subscription reset reported after interruption updates the block (${rateLimitType ?? "no reset"})`,
        async (t) => {
            const { fake, host, chat } = await startPi(t);
            const resetsAt = future();
            fake.onTurn = async turn => {
                turn.emit({ type: "rate_limit_event", rate_limit_info: {
                    status: "allowed", rateLimitType, overageInUse: true,
                    ...(rateLimitType === "overage" ? { resetsAt: resetsAt + 3600 } : {}),
                } });
                await turn.untilAborted();
                turn.emit({ type: "rate_limit_event", rate_limit_info: {
                    status: "allowed", rateLimitType: "five_hour", resetsAt, utilization: 1,
                } });
                turn.emit({ type: "rate_limit_event", rate_limit_info: {
                    status: "allowed", rateLimitType: "overage", resetsAt: resetsAt + 3600, isUsingOverage: true,
                } });
            };
            const run = await chat.ask("first");
            assert.equal(run.message.stopReason, "error");
            assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
            assert.deepEqual(host.warnings, [extraUsageWarning()]);
            assert.equal(fake.processes[0].requests("interrupt").length, 1);
            await eventually(() => fake.running.length === 0);
            replyOk(fake);
            await host.reload();
            assert.equal((await chat.ask("before reset")).message.errorMessage, extraUsageBlocked(resetsAt));
            assert.equal(fake.processes.length, 1, "blocked requests must not start Claude Code");
            t.mock.timers.enable({ apis: ["Date"], now: resetsAt * 1000 });
            const resumed = await chat.ask("after reset");
            t.mock.timers.reset();
            assert.equal(resumed.message.stopReason, "stop");
            assert.equal(fake.userMessages.length, 2);
        });
}

test("a process that dies after reporting extra usage still fails with the extra-usage error and warns", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.onTurn = async (turn) => {
        turn.emit({ type: "rate_limit_event", rate_limit_info: {
            status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true,
        } });
        await turn.untilAborted();
        turn.process.kill("SIGKILL");
    };
    const run = await chat.ask("hello");
    assert.equal(run.message.stopReason, "error");
    assert.equal(run.message.errorMessage, extraUsageStopped(resetsAt));
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    replyOk(fake);
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
});

test("extra usage reported during startup blocks the request before any input is sent", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    fake.onInitialize = child => child.write({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true },
    });
    assert.equal((await chat.ask("hello")).message.errorMessage, extraUsageBlocked(resetsAt));
    assert.deepEqual(fake.userMessages, []);
    assert.deepEqual(host.warnings, [extraUsageWarning()]);
    await eventually(() => fake.running.length === 0);
});

test("after extra usage is seen, later requests are blocked before Claude Code starts", async (t) => {
    const { fake, host, chat } = await startPi(t);
    const resetsAt = future();
    reportOnTurn(fake, { status: "allowed", rateLimitType: "five_hour", resetsAt, overageInUse: true });
    await chat.ask("first");
    replyOk(fake);
    const spawned = fake.processes.length;
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(resetsAt));
    await host.reload();
    assert.equal((await chat.ask("after reload")).message.errorMessage, extraUsageBlocked(resetsAt));
    await host.switchSession("new", SessionManager.inMemory(CWD));
    assert.equal((await new Chat(host).ask("new chat")).message.errorMessage, extraUsageBlocked(resetsAt));
    assert.equal(fake.userMessages.length, 1);
    assert.equal(fake.processes.length, spawned);
});

test("an extra-usage report without a reset time blocks until Pi restarts", async (t) => {
    const { fake, host, chat } = await startPi(t);
    reportOnTurn(fake, { status: "allowed", isUsingOverage: true });
    assert.equal((await chat.ask("first")).message.errorMessage, extraUsageStopped(undefined));
    replyOk(fake);
    assert.equal((await chat.ask("again")).message.errorMessage, extraUsageBlocked(undefined));
    await host.shutdown();
    PiHost.newProcess();
    await host.switchSession("new", SessionManager.inMemory(CWD));
    assert.equal((await new Chat(host).ask("after restart")).message.stopReason, "stop");
});

test("requests run again once the reported subscription window has reset", async (t) => {
    const { fake, chat } = await startPi(t);
    const resetsAt = Math.floor(Date.now() / 1000) + 1;
    reportOnTurn(fake, { status: "allowed", rateLimitType: "five_hour", resetsAt, isUsingOverage: true });
    await chat.ask("first");
    replyOk(fake);
    t.mock.timers.enable({ apis: ["Date"], now: (resetsAt + 1) * 1000 });
    const run = await chat.ask("after reset");
    t.mock.timers.reset();
    assert.equal(run.message.stopReason, "stop");
});

test("the block applies only to the account that drew on extra usage", async (t) => {
    const { fake, host, chat } = await startPi(t);
    reportOnTurn(fake, { status: "allowed", rateLimitType: "five_hour", resetsAt: future(), isUsingOverage: true });
    await chat.ask("on account A");
    replyOk(fake);
    fake.login(ACCOUNT_B);
    await host.switchSession("new", SessionManager.inMemory(CWD));
    assert.equal((await new Chat(host).ask("on account B")).message.stopReason, "stop");
});

test("without a UI the extra-usage warning goes to stderr", async (t) => {
    const { fake, host, chat } = await startPi(t, { hasUI: false });
    reportOnTurn(fake, { status: "allowed", isUsingOverage: true });
    const stderr: string[] = [];
    const stdout: string[] = [];
    const stderrWrite = t.mock.method(process.stderr, "write", (chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
    });
    const stdoutWrite = t.mock.method(process.stdout, "write", (chunk: unknown) => {
        stdout.push(String(chunk));
        return true;
    });
    const run = await chat.ask("hello");
    stderrWrite.mock.restore();
    stdoutWrite.mock.restore();
    assert.equal(run.message.errorMessage, extraUsageStopped(undefined));
    assert.deepEqual(stderr.filter(chunk => chunk.includes("extra usage")), [`${extraUsageWarning()}\n`]);
    // The node:test runner shares this stdout for its own reports, so only the provider's warning text is checked.
    assert.deepEqual(stdout.filter(chunk => chunk.includes(extraUsageWarning())), []);
    assert.deepEqual(host.notifications, []);
});
