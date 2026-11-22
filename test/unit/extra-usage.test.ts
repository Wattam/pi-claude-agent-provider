import assert from "node:assert/strict";
import test from "node:test";
import { ExtraUsageGuard, ExtraUsageTracker, SubscriptionResetTracker } from "../../src/extra-usage.js";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const RESET = 1_900_000_000;

test("only rate-limit reports of extra usage credits in use mark the request as extra usage", () => {
    const enabled = new ExtraUsageTracker();
    enabled.accept({ status: "allowed", overageEnabled: true });
    enabled.accept({ status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected" });
    assert.equal(enabled.extraUsage, undefined);
    const using = new ExtraUsageTracker();
    using.accept({ status: "allowed_warning", isUsingOverage: true, resetsAt: 1_900_000_000 });
    using.accept({ status: "allowed", overageInUse: true, resetsAt: 1_900_000_500 });
    assert.notEqual(using.extraUsage, undefined);
    assert.equal(using.extraUsage?.resetsAt, undefined, "no exhausted subscription window was identified");
    const inUse = new ExtraUsageTracker();
    inUse.accept({ status: "allowed", overageInUse: true });
    assert.notEqual(inUse.extraUsage, undefined);
});

test("extra usage without an exhausted window cannot use an unrelated subscription reset", () => {
    const tracker = new ExtraUsageTracker();
    tracker.accept({ status: "allowed", rateLimitType: "overage", resetsAt: 1_900_001_000 });
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", resetsAt: 1_900_086_400 });
    tracker.accept({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1_900_000_000 });
    const beforeDetection = tracker.extraUsage;
    assert.equal(beforeDetection, undefined, "a subscription reset alone must not trigger extra-usage detection");
    tracker.accept({ status: "allowed", overageInUse: true });
    assert.notEqual(tracker.extraUsage, undefined);
    assert.equal(tracker.extraUsage?.resetsAt, undefined, "neither reported subscription window was exhausted");
    tracker.accept({ status: "allowed", isUsingOverage: true, resetsAt: 1_900_000_900 });
    assert.equal(tracker.extraUsage?.resetsAt, undefined, "an unnamed reset cannot identify the exhausted window");
});

test("extra usage uses the reset of the window its report names", () => {
    const tracker = new ExtraUsageTracker();
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", resetsAt: 1_900_000_000 });
    tracker.accept({
        status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_900_004_000, isUsingOverage: true,
    });
    assert.equal(tracker.extraUsage?.resetsAt, 1_900_004_000, "the exhausted window outranks another window");
    tracker.accept({
        status: "allowed", rateLimitType: "seven_day_opus", resetsAt: 1_900_002_000, overageInUse: true,
    });
    assert.equal(tracker.extraUsage?.resetsAt, 1_900_004_000, "all exhausted windows must reset");
});

for (const initial of [
    { status: "allowed", isUsingOverage: true },
    { status: "allowed", overageInUse: true, rateLimitType: "overage", resetsAt: 1_900_001_000 },
] as const) {
    for (const isUsingOverage of [true, false]) {
        test(`extra usage keeps a later subscription reset (${initial.rateLimitType ?? "no reset"}, `
            + `later overage=${isUsingOverage})`, () => {
            const tracker = new ExtraUsageTracker();
            tracker.accept(initial);
            assert.notEqual(tracker.extraUsage, undefined);
            assert.equal(tracker.extraUsage?.resetsAt, undefined, "no subscription reset has been reported");
            tracker.accept({
                status: "allowed", rateLimitType: "five_hour", resetsAt: 1_900_000_000, utilization: 1, isUsingOverage,
            });
            assert.equal(tracker.extraUsage?.resetsAt, 1_900_000_000);
            tracker.accept({ status: "allowed", overageEnabled: true });
            tracker.accept({ status: "allowed", rateLimitType: "seven_day", resetsAt: 1_900_086_400 });
            tracker.accept({
                status: "allowed", rateLimitType: "overage", resetsAt: 1_900_001_000, overageInUse: true,
            });
            assert.equal(tracker.extraUsage?.resetsAt, 1_900_000_000, "later reports cannot erase the reset");
        });
    }
}

test("a recorded account is blocked until its subscription window resets", () => {
    const guard = new ExtraUsageGuard();
    guard.record(ACCOUNT_A, RESET);
    assert.deepEqual(guard.blocked(ACCOUNT_A, RESET * 1000 - 1), { resetsAt: RESET });
    assert.equal(guard.blocked(ACCOUNT_B, RESET * 1000 - 1), undefined);
    assert.equal(guard.blocked(ACCOUNT_A, RESET * 1000), undefined);
    assert.equal(guard.blocked(ACCOUNT_A, RESET * 1000 - 1), undefined, "an expired block is cleared");
});

test("a record without a reset time blocks for the guard's lifetime", () => {
    const guard = new ExtraUsageGuard();
    guard.record(ACCOUNT_A, undefined);
    assert.deepEqual(guard.blocked(ACCOUNT_A, Number.MAX_SAFE_INTEGER), {});
});

test("an exhausted window without a reset can extend an existing account block to process restart", () => {
    const guard = new ExtraUsageGuard();
    guard.record(ACCOUNT_A, RESET);
    guard.record(ACCOUNT_A, undefined);
    assert.deepEqual(guard.blocked(ACCOUNT_A, Number.MAX_SAFE_INTEGER), {});
});

test("the reset of the exhausted overage window itself cannot bound a block", () => {
    const tracker = new SubscriptionResetTracker();
    tracker.accept({ status: "rejected", rateLimitType: "overage", resetsAt: RESET });
    assert.equal(tracker.resetsAt, undefined, "the overage window is not a subscription window");
    tracker.accept({ status: "rejected", rateLimitType: "five_hour", resetsAt: RESET + 3600 });
    assert.equal(tracker.resetsAt, RESET + 3600);
});

for (const weeklyFirst of [false, true]) {
    test(`all exhausted subscription windows must reset (weekly first=${weeklyFirst})`, () => {
        const tracker = new SubscriptionResetTracker();
        const reports = [
            { status: "allowed", rateLimitType: "five_hour", resetsAt: RESET, isUsingOverage: true },
            { status: "allowed", rateLimitType: "seven_day", resetsAt: RESET + 86_400, overageInUse: true },
        ] as const;
        for (const report of weeklyFirst ? [...reports].reverse() : reports) tracker.accept(report);
        tracker.accept({ status: "allowed", rateLimitType: "seven_day_opus", resetsAt: RESET + 604_800 });
        const guard = new ExtraUsageGuard();
        guard.record(ACCOUNT_A, tracker.resetsAt);
        assert.deepEqual(guard.blocked(ACCOUNT_A, RESET * 1000), { resetsAt: RESET + 86_400 });
        assert.equal(guard.blocked(ACCOUNT_A, (RESET + 86_400) * 1000), undefined);
    });
}

test("non-exhausted subscription windows cannot bound an extra-usage block", () => {
    const tracker = new SubscriptionResetTracker();
    tracker.accept({ status: "allowed", rateLimitType: "five_hour", resetsAt: RESET, utilization: 0.2 });
    tracker.accept({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: RESET + 86_400 });
    tracker.accept({ status: "allowed", rateLimitType: "overage", resetsAt: RESET + 3600, overageInUse: true });
    const guard = new ExtraUsageGuard();
    guard.record(ACCOUNT_A, tracker.resetsAt);
    assert.deepEqual(guard.blocked(ACCOUNT_A, Number.MAX_SAFE_INTEGER), {});
});

for (const evidence of [{ status: "rejected" }, { status: "allowed_warning", utilization: 1 }] as const) {
    test(`exhausted-window evidence supplies a reset without an overage flag (${evidence.status})`, () => {
        const tracker = new SubscriptionResetTracker();
        tracker.accept({ ...evidence, rateLimitType: "seven_day", resetsAt: RESET + 86_400 });
        tracker.accept({ status: "allowed", rateLimitType: "five_hour", resetsAt: RESET });
        assert.equal(tracker.resetsAt, RESET + 86_400);
    });
}

test("an earlier reset applies only when its own window is later identified as exhausted", () => {
    const tracker = new SubscriptionResetTracker();
    tracker.accept({ status: "allowed", rateLimitType: "five_hour", resetsAt: RESET });
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", resetsAt: RESET + 86_400 });
    assert.equal(tracker.resetsAt, undefined);
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", overageInUse: true });
    assert.equal(tracker.resetsAt, RESET + 86_400);
});

test("an exhausted window with a missing reset cannot be hidden by another exhausted window", () => {
    const tracker = new SubscriptionResetTracker();
    tracker.accept({ status: "allowed", rateLimitType: "five_hour", resetsAt: RESET, isUsingOverage: true });
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", overageInUse: true });
    assert.equal(tracker.resetsAt, undefined);
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", resetsAt: RESET + 86_400 });
    assert.equal(tracker.resetsAt, RESET + 86_400, "a later report can supply that exhausted window's reset");
    tracker.accept({ status: "allowed", rateLimitType: "seven_day", overageInUse: true });
    assert.equal(tracker.resetsAt, RESET + 86_400, "missing data cannot erase a known window reset");
});
