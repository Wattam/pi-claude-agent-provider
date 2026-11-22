import assert from "node:assert/strict";
import test from "node:test";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import type { Usage } from "@earendil-works/pi-ai";
import { UsageTracker } from "../../src/usage.js";
import { SONNET } from "../fixtures/pi-host.js";

type SdkUsage = Parameters<UsageTracker["update"]>[1];

const sdk = (fields: Record<string, unknown>): SdkUsage => fields as unknown as SdkUsage;
const tokens = (input: number, cacheRead: number, cacheWrite: number, output: number): SdkUsage => sdk({
    input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
});
const counts = (usage: Usage): number[] =>
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
const empty = (): Usage => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test("repeated reports for one API message keep the maximum of each counter", () => {
    const tracker = new UsageTracker();
    tracker.update("msg_1", tokens(40, 900, 0, 1));
    tracker.update("msg_1", tokens(40, 900, 0, 25));
    tracker.update("msg_1", tokens(40, 900, 0, 25));
    const usage = empty();
    tracker.apply(SONNET, usage);
    assert.deepEqual(counts(usage), [40, 25, 900, 0, 965]);
});

test("several API calls in one turn sum output and take input-side counts from the last call", () => {
    const tracker = new UsageTracker();
    tracker.update("msg_1", sdk({
        input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000, output_tokens: 30,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5_000 },
        output_tokens_details: { thinking_tokens: 12 },
    }));
    tracker.update("msg_2", sdk({
        input_tokens: 15, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 200, output_tokens: 20,
        cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 3 },
    }));
    tracker.result(tokens(999, 999, 999, 999) as NonNullableUsage);
    const usage = empty();
    tracker.apply(SONNET, usage);
    assert.equal(usage.input, 15);
    assert.equal(usage.cacheRead, 5_000);
    assert.equal(usage.cacheWrite, 200);
    assert.equal(usage.cacheWrite1h, 200);
    assert.equal(usage.output, 50);
    assert.equal(usage.reasoning, 15);
    assert.equal(usage.totalTokens, 15 + 50 + 5_000 + 200);
});

test("result totals apply only when no API message usage was seen", () => {
    const tracker = new UsageTracker();
    tracker.result(tokens(7, 2, 1, 3) as NonNullableUsage);
    const usage = empty();
    tracker.apply(SONNET, usage);
    assert.deepEqual(counts(usage), [7, 3, 2, 1, 13]);
});

test("subscription usage reports zero cost and does not claim a provider-reported charge", () => {
    const tracker = new UsageTracker();
    tracker.update("msg_1", tokens(1_000, 0, 0, 1_000));
    const usage = empty();
    tracker.apply(SONNET, usage);
    const { totalFromProvider, ...charges } = usage.cost;
    assert.deepEqual(charges, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.notEqual(totalFromProvider, true);
});
