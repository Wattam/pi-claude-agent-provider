import assert from "node:assert/strict";
import test from "node:test";
import {
    extraUsageBlocked, extraUsageStopped, extraUsageWarning, serverError, stopped, truncateReason,
} from "../../src/messages.js";

const RESETS_AT = 1767225600;
const RESET_TIME = "2026-01-01T00:00:00.000Z";

test("reasons are collapsed to one trimmed line and cut to 200 characters with an ellipsis", () => {
    assert.equal(truncateReason("  first\n\n  second\tthird  "), "first second third");
    const long = truncateReason(`${"word ".repeat(100)}end`);
    assert.equal(long.length, 200);
    assert.ok(long.endsWith("…"));
    assert.equal(truncateReason("x".repeat(200)), "x".repeat(200));
});

test("server errors name overload separately from other HTTP failures", () => {
    assert.match(serverError(529), /^Anthropic is overloaded \(529\)\. Claude Code exhausted its retries\./);
    assert.match(serverError(503), /^Anthropic returned HTTP 503\. Claude Code exhausted its retries\./);
});

test("the extra-usage stop names the used-up quota, the no-paid-billing policy, and the block", () => {
    assert.equal(extraUsageStopped(RESETS_AT), "Claude Agent stopped this chat: Claude reported that this request "
        + "uses extra usage credits because the subscription quota is used up. Claude Agent never relies on paid "
        + `billing. Requests for this Claude account are blocked until the quota resets at ${RESET_TIME}.`);
    assert.equal(extraUsageStopped(), "Claude Agent stopped this chat: Claude reported that this request uses extra "
        + "usage credits because the subscription quota is used up. Claude Agent never relies on paid billing. "
        + "Requests for this Claude account are blocked until Pi restarts.");
});

test("the extra-usage warning states the possible billing and how to prevent paid usage", () => {
    assert.equal(extraUsageWarning(), "Claude Agent: a request drew on extra usage credits before it could be "
        + "stopped and may be billed. Disable extra usage for this Claude account or organization to prevent any "
        + "paid usage.");
});

test("the extra-usage block names the used-up quota, the extra-usage billing, and the block", () => {
    assert.equal(extraUsageBlocked(RESETS_AT), "Claude Agent blocked this request: the subscription quota is used up "
        + "and Claude would bill it as extra usage credits. Requests for this Claude account are blocked until the "
        + `quota resets at ${RESET_TIME}.`);
    assert.equal(extraUsageBlocked(), "Claude Agent blocked this request: the subscription quota is used up and "
        + "Claude would bill it as extra usage credits. Requests for this Claude account are blocked until Pi "
        + "restarts.");
});

test("a stopped process includes its last stderr output only when present", () => {
    assert.equal(stopped(), "Claude Code stopped before finishing its reply.");
    assert.equal(stopped("fatal: x"), "Claude Code stopped before finishing its reply. Last output: fatal: x");
});
