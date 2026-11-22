import type { NonNullableUsage, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";

type BetaUsage = SDKAssistantMessage["message"]["usage"];

/** The counters an Anthropic usage report can carry; stream deltas report only some of them. */
interface UsageReport {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
}

interface Counters {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    output: number;
    reasoning?: number;
}

function larger(current: number | undefined, reported: number | null | undefined): number | undefined {
    if (typeof reported !== "number") return current;
    return Math.max(current ?? 0, reported);
}

function merge(current: Counters, report: UsageReport): Counters {
    return {
        input: larger(current.input, report.input_tokens) ?? 0,
        cacheRead: larger(current.cacheRead, report.cache_read_input_tokens) ?? 0,
        cacheWrite: larger(current.cacheWrite, report.cache_creation_input_tokens) ?? 0,
        cacheWrite1h: larger(current.cacheWrite1h, report.cache_creation?.ephemeral_1h_input_tokens),
        output: larger(current.output, report.output_tokens) ?? 0,
        reasoning: larger(current.reasoning, report.output_tokens_details?.thinking_tokens),
    };
}

const EMPTY: Counters = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/**
 * Deduplicates SDK usage for one Pi response. Claude Code repeats reports for the same API message, so each counter
 * keeps its maximum per message. Output is summed over the API messages; input-side counts come from the last one,
 * because each call re-reads the whole prompt. Result totals apply only when no per-message usage arrived.
 */
export class UsageTracker {
    private readonly messages = new Map<string, Counters>();
    private last: string | undefined;
    private fallback: Counters | undefined;

    update(apiMessageId: string, usage: BetaUsage | NonNullableUsage | UsageReport): void {
        this.messages.set(apiMessageId, merge(this.messages.get(apiMessageId) ?? EMPTY, usage as UsageReport));
        this.last = apiMessageId;
    }

    result(usage: NonNullableUsage): void {
        if (this.messages.size === 0) this.fallback = merge(EMPTY, usage as UsageReport);
    }

    apply(model: Model<Api>, target: Usage): void {
        const all = this.messages.size > 0 ? [...this.messages.values()] : this.fallback ? [this.fallback] : [];
        const last = (this.last ? this.messages.get(this.last) : undefined) ?? this.fallback ?? EMPTY;
        target.input = last.input;
        target.cacheRead = last.cacheRead;
        target.cacheWrite = last.cacheWrite;
        if (last.cacheWrite1h !== undefined) target.cacheWrite1h = last.cacheWrite1h;
        target.output = all.reduce((sum, counters) => sum + counters.output, 0);
        if (all.some(counters => counters.reasoning !== undefined)) {
            target.reasoning = all.reduce((sum, counters) => sum + (counters.reasoning ?? 0), 0);
        }
        target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
        // Catalog cost is zero: the subscription covers usage, so this is never an API-price charge.
        target.cost = calculateCost(model, target);
    }
}
