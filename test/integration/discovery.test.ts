import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { toPiModel } from "../../src/catalog.js";
import { realIO, type ClaudeIO } from "../../src/io.js";
import { FakeClaude } from "../fixtures/fake-claude.js";
import { eventually, PiHost } from "../fixtures/pi-host.js";

interface Refresh {
    context: RefreshModelsContext;
    published: ModelsPublication[];
}

function refresh(options: { stored?: ModelsStoreEntry; allowNetwork?: boolean; accept?: boolean } = {}): Refresh {
    const published: ModelsPublication[] = [];
    const context: RefreshModelsContext = {
        stored: options.stored,
        allowNetwork: options.allowNetwork ?? true,
        signal: new AbortController().signal,
        publish: async (publication) => {
            published.push(publication);
            if (options.accept === false) return false;
            publication.update?.();
            return true;
        },
    };
    return { context, published };
}

function provider(fake: FakeClaude, io: ClaudeIO = fake.io()) {
    const host = new PiHost(io);
    host.load();
    return host.provider;
}

const ids = (models: readonly Model<string>[]): string[] => models.map(model => model.id);

test("network discovery lists the login's explicit models without submitting a prompt", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake);
    const { context, published } = refresh();
    await claude.refreshModels?.(context);
    assert.deepEqual(ids(claude.getModels()), ["opus", "sonnet"]);
    const [opus, sonnet] = claude.getModels();
    assert.equal(opus.contextWindow, 1_000_000);
    assert.equal(sonnet.contextWindow, 200_000);
    assert.equal(sonnet.maxTokens, 32_000);
    assert.deepEqual(sonnet.thinkingLevelMap,
        { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
    const persisted = published.at(-1)?.persist;
    assert.ok(persisted);
    assert.deepEqual(ids(persisted.models as Model<string>[]), ["opus", "sonnet"]);
    assert.equal(typeof persisted.checkedAt, "number");
    assert.equal(fake.userMessages.length, 0);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.processes[0].persist, false);
    await eventually(() => fake.processes[0].exited);
    assert.equal(fake.processes[0].options.env.ANTHROPIC_API_KEY, undefined);
});

test("models without a readable context window use the documented fallback", async () => {
    const fake = new FakeClaude();
    fake.contextWindows = { opus: "error" };
    const claude = provider(fake);
    await claude.refreshModels?.(refresh().context);
    assert.deepEqual(claude.getModels().map(model => [model.id, model.contextWindow, model.maxTokens]),
        [["opus", 200_000, 32_000], ["sonnet", 200_000, 32_000]]);
});

test("a stored catalog restores without network access or a Claude process", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake);
    const stored = { models: [toPiModel({ id: "sonnet", name: "Sonnet", efforts: ["low"] })], checkedAt: 1 };
    const { context, published } = refresh({ stored, allowNetwork: false });
    await claude.refreshModels?.(context);
    assert.deepEqual(ids(claude.getModels()), ["sonnet"]);
    assert.equal(published.length, 1);
    assert.equal(published[0].persist, undefined);
    assert.equal(fake.processes.length, 0);
    assert.equal(fake.authStatusCalls, 0);
});

test("a rejected stored publication skips network discovery", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake);
    const stored = { models: [toPiModel({ id: "sonnet", name: "Sonnet", efforts: [] })] };
    await claude.refreshModels?.(refresh({ stored, accept: false }).context);
    assert.equal(fake.processes.length, 0);
});

test("discovery without an installed claude keeps the previous catalog", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake, fake.io({ which: () => undefined }));
    const stored = { models: [toPiModel({ id: "sonnet", name: "Sonnet", efforts: [] })] };
    await claude.refreshModels?.(refresh({ stored }).context);
    assert.deepEqual(ids(claude.getModels()), ["sonnet"]);
    assert.equal(fake.processes.length, 0);
});

test("a discovery failure reports Claude Code's last output", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake, fake.io({
        // A real child that writes a diagnostic and exits before it can answer the probe's initialize.
        spawn: (options, onStderr) => realIO.spawn({
            ...options,
            command: process.execPath,
            args: ["-e", "process.stderr.write('fixture diagnostic'); process.exit(3)"],
            cwd: process.cwd(),
        }, onStderr),
    }));
    await assert.rejects(
        claude.refreshModels?.(refresh().context) ?? Promise.resolve(),
        /Last output: fixture diagnostic/,
    );
});

test("a failed discovery propagates and leaves the published catalog unchanged", async () => {
    const fake = new FakeClaude();
    const claude = provider(fake, fake.io({
        spawn: () => {
            throw new Error("fixture spawn failure");
        },
    }));
    const stored = { models: [toPiModel({ id: "sonnet", name: "Sonnet", efforts: [] })] };
    const { context, published } = refresh({ stored });
    await assert.rejects(claude.refreshModels?.(context) ?? Promise.resolve());
    assert.deepEqual(ids(claude.getModels()), ["sonnet"]);
    assert.equal(published.length, 1);
});
