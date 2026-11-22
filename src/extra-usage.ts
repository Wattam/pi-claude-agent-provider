import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

/** True when a Claude Code rate-limit report says the current request draws on extra usage credits. */
export function usesExtraUsage(info: SDKRateLimitInfo): boolean {
    return info.isUsingOverage === true || info.overageInUse === true;
}

/** Latched policy state for one native turn, shared across its Pi tool continuations and interruption. */
export class ExtraUsageTracker {
    private readonly subscriptionResets = new SubscriptionResetTracker();
    private detected: { resetsAt?: number } | undefined;

    accept(info: SDKRateLimitInfo): void {
        this.subscriptionResets.accept(info);
        if (usesExtraUsage(info)) this.detected ??= {};
        if (this.detected) this.detected.resetsAt = this.subscriptionResets.resetsAt;
    }

    get extraUsage(): { resetsAt?: number } | undefined {
        return this.detected;
    }
}

/**
 * Process-lifetime record of accounts seen drawing on extra usage credits, keyed by account digest, in memory only.
 * An account stays blocked until the reported subscription window resets, or for the Pi process when no reset time
 * was reported.
 */
export class ExtraUsageGuard {
    private readonly blockedUntil = new Map<string, number | undefined>();

    /**
     * Records the request tracker's aggregate reset in epoch seconds, not an individual rate-limit report.
     * An undefined reset can extend a timed block when another exhausted window has no known reset.
     */
    record(accountKey: string, resetsAt: number | undefined): void {
        this.blockedUntil.set(accountKey, resetsAt === undefined ? undefined : resetsAt * 1000);
    }

    /** The block for the account, or undefined when requests may run. `resetsAt` is in epoch seconds. */
    blocked(accountKey: string, now = Date.now()): { resetsAt?: number } | undefined {
        if (!this.blockedUntil.has(accountKey)) return undefined;
        const until = this.blockedUntil.get(accountKey);
        if (until === undefined) return {};
        if (now >= until) {
            this.blockedUntil.delete(accountKey);
            return undefined;
        }
        return { resetsAt: until / 1000 };
    }
}

/**
 * Tracks exhausted subscription windows of one request, including reports drained during interruption.
 * Every exhausted window must reset before subscription requests can run again. An unrelated window's reset cannot
 * bound the block. Later reports can fill missing reset data for an already identified exhausted window.
 */
export class SubscriptionResetTracker {
    private readonly exhausted = new Set<NonNullable<SDKRateLimitInfo["rateLimitType"]>>();
    private readonly resets = new Map<NonNullable<SDKRateLimitInfo["rateLimitType"]>, number>();

    accept(info: SDKRateLimitInfo): void {
        // `resetsAt` describes the window named by `rateLimitType` (Claude Code's representative-claim header), so
        // an unnamed report carries no identified window and an "overage" report carries the extra-usage window's
        // reset, never a subscription reset.
        const window = info.rateLimitType;
        if (window === undefined || window === "overage") return;
        const reset = info.resetsAt;
        if (reset !== undefined) this.resets.set(window, Math.max(this.resets.get(window) ?? reset, reset));
        if (usesExtraUsage(info) || info.status === "rejected" || (info.utilization ?? 0) >= 1) {
            this.exhausted.add(window);
        }
    }

    /** Latest exhausted-window reset in epoch seconds, or undefined if any exhausted reset remains unknown. */
    get resetsAt(): number | undefined {
        let latest: number | undefined;
        for (const window of this.exhausted) {
            const reset = this.resets.get(window);
            if (reset === undefined) return undefined;
            latest = Math.max(latest ?? reset, reset);
        }
        return latest;
    }
}
