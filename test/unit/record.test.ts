import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY_TYPE } from "../../src/constants.js";
import { readRecord, type ContinuationRecord } from "../../src/record.js";

const HASH = "c".repeat(64);

function record(overrides: Partial<ContinuationRecord> = {}): ContinuationRecord {
    return {
        version: 1, piSessionId: "pi-session", revision: 1, claudeSessionId: "claude-session",
        accountKey: "d".repeat(64), seen: { count: 2, hash: HASH },
        good: { count: 2, hash: HASH, claudeMessageId: "uuid-1" }, failed: false,
        ...overrides,
    };
}

test("a session without continuation state has no record", () => {
    const sessionManager = SessionManager.inMemory("/work/project");
    sessionManager.appendCustomEntry("other-extension", { revision: 9 });
    assert.deepEqual(readRecord(sessionManager), { record: undefined, invalid: false, latestRevision: 0 });
});

test("the last branch record is current and the latest revision spans the same Claude session", () => {
    const sessionManager = SessionManager.inMemory("/work/project");
    sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, record({ revision: 1 }));
    sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, record({ revision: 5, claudeSessionId: "unrelated" }));
    sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, record({ revision: 2, seen: { count: 0, hash: "" } }));
    assert.deepEqual(readRecord(sessionManager), {
        record: record({ revision: 2, seen: { count: 0, hash: "" } }), invalid: false, latestRevision: 2,
    });
});

test("navigating back to an earlier branch exposes a revision older than the latest", () => {
    const sessionManager = SessionManager.inMemory("/work/project");
    const first = sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, record({ revision: 1 }));
    sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, record({ revision: 2 }));
    sessionManager.branch(first);
    const state = readRecord(sessionManager);
    assert.equal(state.record?.revision, 1);
    assert.equal(state.latestRevision, 2);
});

test("malformed continuation state is reported as invalid", () => {
    const malformed: unknown[] = [
        { ...record(), version: 2 },
        { ...record(), claudeSessionId: 7 },
        { ...record(), seen: { count: -1, hash: HASH } },
        { ...record(), seen: { count: 1.5, hash: HASH } },
        { ...record(), good: { count: 1, hash: "not-a-hash" } },
        { ...record(), failed: "no" },
        "text",
    ];
    for (const data of malformed) {
        const sessionManager = SessionManager.inMemory("/work/project");
        sessionManager.appendCustomEntry(STATE_ENTRY_TYPE, data);
        assert.equal(readRecord(sessionManager).invalid, true, JSON.stringify(data));
    }
});
