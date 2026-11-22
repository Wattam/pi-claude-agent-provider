import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { getSupportedThinkingLevels, type AnyModel } from "@earendil-works/pi-ai";
import { discoverCatalog, restoreStored, thinkingLevelMap, toPiModel } from "../../src/catalog.js";
import { DISCOVERY_TIMEOUT_MS } from "../../src/constants.js";
import type { Probe } from "../../src/probe.js";
import { DEFAULT_MODELS } from "../fixtures/fake-claude.js";

interface ProbeLog {
    setModel: string[];
    contextUsage: unknown[];
}

type Windows = Record<string, () => Promise<unknown>>;

function fakeProbe(models: ModelInfo[], windows: Windows): { probe: Probe; log: ProbeLog } {
    const log: ProbeLog = { setModel: [], contextUsage: [] };
    let current = "";
    const probe = {
        init: { models },
        query: {
            setModel: async (model: string) => {
                current = model;
                log.setModel.push(model);
            },
            getContextUsage: async (options: unknown) => {
                log.contextUsage.push(options);
                return windows[current]();
            },
        },
        close: () => undefined,
    } as unknown as Probe;
    return { probe, log };
}

const usage = (rawMaxTokens: unknown) => async () => ({ rawMaxTokens, maxTokens: 1 });

test("discovery lists explicit models, excludes default, and reads each context window", async () => {
    const { probe, log } = fakeProbe(DEFAULT_MODELS, { opus: usage(1_000_000), sonnet: usage(200_000) });
    assert.deepEqual(await discoverCatalog(probe), [
        { id: "opus", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1_000_000 },
        { id: "sonnet", name: "Sonnet", efforts: ["low", "medium", "high"], contextWindow: 200_000 },
    ]);
    assert.deepEqual(log.setModel, ["opus", "sonnet"]);
    assert.deepEqual(log.contextUsage, [{ detail: "summary" }, { detail: "summary" }]);
});

test("discovery leaves invalid or failed context windows unset", async () => {
    const models: ModelInfo[] = ["zero", "fraction", "text", "failing", "haiku"]
        .map(value => ({ value, displayName: value.toUpperCase(), description: value }));
    const { probe } = fakeProbe(models, {
        zero: usage(0),
        fraction: usage(1.5),
        text: usage("200000"),
        failing: async () => {
            throw new Error("context usage unavailable");
        },
        haiku: usage(64_000),
    });
    const entries = await discoverCatalog(probe);
    assert.deepEqual(entries.map(entry => entry.contextWindow), [undefined, undefined, undefined, undefined, 64_000]);
    assert.deepEqual(entries.map(entry => entry.efforts), [[], [], [], [], []]);
});

test("discovery stops reading context windows at its deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { probe } = fakeProbe(DEFAULT_MODELS, { opus: usage(1_000_000), sonnet: () => new Promise(() => undefined) });
    const pending = discoverCatalog(probe);
    let settled = false;
    void pending.finally(() => {
        settled = true;
    });
    for (let step = 0; step < 50 && !settled; step++) {
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(step === 0 ? DISCOVERY_TIMEOUT_MS : 0);
    }
    const entries = await pending;
    assert.equal(entries.find(entry => entry.id === "opus")?.contextWindow, 1_000_000);
    assert.equal(entries.find(entry => entry.id === "sonnet")?.contextWindow, undefined);
});

const SONNET_LEVELS = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };

test("thinking levels map only supported efforts and never off or minimal", () => {
    assert.equal(thinkingLevelMap([]), undefined);
    assert.deepEqual(thinkingLevelMap(["low", "medium", "high"]), SONNET_LEVELS);
});

test("Pi models expose supported thinking levels and documented limit fallbacks", () => {
    const sonnet = toPiModel({ id: "sonnet", name: "Sonnet", efforts: ["low", "medium", "high"] });
    assert.deepEqual(sonnet, {
        id: "sonnet", name: "Sonnet", api: "claude-agent-sdk", provider: "claude-agent", baseUrl: "claude-code://local",
        reasoning: true,
        thinkingLevelMap: SONNET_LEVELS,
        input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000, maxTokens: 32_000,
    });
    assert.deepEqual(getSupportedThinkingLevels(sonnet), ["low", "medium", "high"]);
    const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
    const opus = toPiModel({ id: "opus", name: "Opus", efforts: [...efforts], contextWindow: 1_000_000 });
    assert.deepEqual(getSupportedThinkingLevels(opus), [...efforts]);
    assert.equal(opus.contextWindow, 1_000_000);
});

test("a model without effort levels has thinking disabled and no thinking map", () => {
    const haiku = toPiModel({ id: "haiku", name: "Haiku", efforts: [] });
    assert.equal(haiku.reasoning, false);
    assert.equal("thinkingLevelMap" in haiku, false);
    assert.equal("promptCache" in haiku, false);
    assert.deepEqual(getSupportedThinkingLevels(haiku), ["off"]);
});

test("stored catalogs restore only Claude Agent chat models", () => {
    const sonnet = toPiModel({ id: "sonnet", name: "Sonnet", efforts: ["low"] });
    const models = [
        sonnet,
        { ...sonnet, id: "other-provider", provider: "anthropic" },
        { ...sonnet, id: "other-api", api: "anthropic-messages" },
        { ...sonnet, id: "classifier", type: "classifier" },
    ] as unknown as AnyModel[];
    assert.deepEqual(restoreStored({ models }), [sonnet]);
    assert.deepEqual(restoreStored(undefined), []);
});
