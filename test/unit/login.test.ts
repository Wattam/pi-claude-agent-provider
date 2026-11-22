import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ClaudeIO } from "../../src/io.js";
import { readLoginIdentity } from "../../src/login.js";
import { NOT_LOGGED_IN, authStatusFailed, unsupportedRoute } from "../../src/messages.js";
import { EXECUTABLE } from "../fixtures/fake-claude.js";

const SUBSCRIPTION = {
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
    email: "ada@example.test", orgId: "org-a", orgName: "Org A", subscriptionType: "enterprise",
};

function statusIO(stdout: unknown, exitCode = 0, stderr = ""): ClaudeIO & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
        calls,
        which: () => EXECUTABLE,
        env: () => ({}),
        spawn: () => { throw new Error("Login must not start a Claude session"); },
        authStatus: async (...args: unknown[]) => {
            calls.push(args);
            return { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr, exitCode };
        },
        sessionExists: async () => false,
    };
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a subscription login yields only a SHA-256 account key over email and organization", async () => {
    const io = statusIO(SUBSCRIPTION);
    const env = { PATH: "/usr/bin" };
    const identity = await readLoginIdentity(io, EXECUTABLE, env);
    assert.deepEqual(identity, { accountKey: sha256("ada@example.test\norg-a") });
    assert.equal(io.calls[0][0], EXECUTABLE);
    assert.deepEqual(io.calls[0][1], env);
    assert.doesNotMatch(JSON.stringify(identity), /ada@example\.test|org-a|Org A/);
});

test("a different organization for the same email yields a different account key", async () => {
    const first = await readLoginIdentity(statusIO(SUBSCRIPTION), EXECUTABLE, {});
    const second = await readLoginIdentity(statusIO({ ...SUBSCRIPTION, orgId: "org-b" }), EXECUTABLE, {});
    assert.notEqual(first.accountKey, second.accountKey);
});

test("an Enterprise Standard seat is accepted when the login route is the subscription", async () => {
    const identity = await readLoginIdentity(statusIO({ ...SUBSCRIPTION, seatTier: "standard" }), EXECUTABLE, {});
    assert.match(identity.accountKey, /^[0-9a-f]{64}$/);
});

test("a logged-out status is rejected with the login instruction", async () => {
    await assert.rejects(readLoginIdentity(statusIO({ loggedIn: false }), EXECUTABLE, {}), { message: NOT_LOGGED_IN });
});

test("non-subscription routes are rejected before inference", async () => {
    const cases: [object, string][] = [
        [{ ...SUBSCRIPTION, apiProvider: "bedrock" }, "bedrock"],
        [{ ...SUBSCRIPTION, apiProvider: undefined }, "unknown"],
        [{ ...SUBSCRIPTION, authMethod: "api_key" }, "api_key"],
        [{ ...SUBSCRIPTION, authMethod: undefined }, "unknown"],
    ];
    for (const [status, route] of cases) {
        await assert.rejects(readLoginIdentity(statusIO(status), EXECUTABLE, {}), { message: unsupportedRoute(route) });
    }
});

test("unreadable status output reports the first stderr line or the exit code", async () => {
    await assert.rejects(readLoginIdentity(statusIO("not json", 1, "boom happened\nsecond line"), EXECUTABLE, {}),
        { message: authStatusFailed("boom happened") });
    await assert.rejects(readLoginIdentity(statusIO("not json", 7), EXECUTABLE, {}),
        { message: authStatusFailed("exit code 7") });
});

test("a failed status command reports its truncated reason", async () => {
    const io: ClaudeIO = {
        ...statusIO(SUBSCRIPTION),
        authStatus: async () => {
            throw new Error("spawn   claude\n  ENOENT");
        },
    };
    await assert.rejects(readLoginIdentity(io, EXECUTABLE, {}), { message: authStatusFailed("spawn claude ENOENT") });
});

test("a status command rejected with a non-Error value reports that value as its reason", async () => {
    const io: ClaudeIO = {
        ...statusIO(SUBSCRIPTION),
        authStatus: () => Promise.reject("claude   exited"),
    };
    await assert.rejects(readLoginIdentity(io, EXECUTABLE, {}), { message: authStatusFailed("claude exited") });
});
