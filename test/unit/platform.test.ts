import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../index.js";

test("Claude Agent provider registration on Linux", async (t) => {
    const original = process.platform;
    t.after(() => Object.defineProperty(process, "platform", { value: original }));
    Object.defineProperty(process, "platform", { value: "linux" });

    const registered: string[] = [];
    const pi = {
        registerProvider: ({ id }: Provider) => registered.push(id),
        on: () => {},
    } as unknown as ExtensionAPI;
    await extension(pi);
    assert.deepEqual(registered, ["claude-agent"]);
});
