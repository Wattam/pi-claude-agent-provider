import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { realIO } from "../../src/io.js";
import { FakeClaude } from "../fixtures/fake-claude.js";
import { startPi, textOf } from "../fixtures/pi-host.js";

test("first message and continuation work through the production process launcher", { timeout: 10_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-launcher-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const executable = join(dir, "claude");
    const fixture = new URL("../fixtures/stdio-claude.js", import.meta.url);
    await writeFile(executable, `#!/usr/bin/env node\nimport(${JSON.stringify(fixture.href)});\n`, { mode: 0o755 });

    const fake = new FakeClaude();
    const { chat, host } = await startPi(t, {
        fake,
        io: fake.io({
            which: () => executable,
            env: () => ({ PATH: dirname(process.execPath), HOME: dir }),
            // PiHost uses a synthetic /work/project cwd. Launch the fixture in this existing directory.
            spawn: (options, onStderr) => realIO.spawn({ ...options, cwd: dir }, onStderr),
        }),
    });
    const first = await chat.ask("First message");
    assert.equal(first.message.stopReason, "stop", first.message.errorMessage ?? "First message did not finish");
    assert.equal(textOf(first.message), "ok");
    const second = await chat.ask("Continue");
    assert.equal(second.message.stopReason, "stop", second.message.errorMessage ?? "Continuation did not finish");
    assert.equal(textOf(second.message), "ok");
    assert.equal(host.records.length, 2);
    assert.equal(host.records[0].claudeSessionId, host.records[1].claudeSessionId);
});
