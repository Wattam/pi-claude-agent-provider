import type { EffortLevel, Query } from "@anthropic-ai/claude-agent-sdk";
import { isModelType, type Model, type ModelsStoreEntry, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { deferred } from "./async.js";
import {
    API_ID, DISCOVERY_TIMEOUT_MS, FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS, MODEL_BASE_URL, PROVIDER_ID,
} from "./constants.js";
import type { Probe } from "./probe.js";

export interface CatalogEntry {
    id: string;
    name: string;
    efforts: EffortLevel[];
    contextWindow?: number;
}

/** The model's context capacity, or undefined when Claude Code reports none. */
async function readContextWindow(query: Query, model: string): Promise<number | undefined> {
    try {
        await query.setModel(model);
        const usage = await query.getContextUsage({ detail: "summary" });
        // rawMaxTokens is capacity; maxTokens can reflect Claude Code's own compaction window.
        const raw: unknown = usage.rawMaxTokens;
        return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
    } catch {
        return undefined;
    }
}

/** Lists the login's explicit models and reads each context window within one deadline. Submits no prompt. */
export async function discoverCatalog(probe: Probe, signal?: AbortSignal): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = probe.init.models
        .filter(model => model.value !== "default")
        .map(model => ({ id: model.value, name: model.displayName, efforts: [...model.supportedEffortLevels ?? []] }));
    const expired = deferred<"expired">();
    const timer = setTimeout(() => expired.resolve("expired"), DISCOVERY_TIMEOUT_MS);
    try {
        for (const entry of entries) {
            if (signal?.aborted) break;
            const outcome = await Promise.race([readContextWindow(probe.query, entry.id), expired.promise]);
            if (outcome === "expired") break;
            if (outcome !== undefined) entry.contextWindow = outcome;
        }
    } finally {
        clearTimeout(timer);
    }
    return entries;
}

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Maps each supported effort to itself; `off`, `minimal`, and unsupported levels are null. */
export function thinkingLevelMap(efforts: readonly EffortLevel[]): ThinkingLevelMap | undefined {
    if (efforts.length === 0) return undefined;
    const map: ThinkingLevelMap = { off: null, minimal: null };
    for (const level of EFFORT_LEVELS) map[level] = efforts.includes(level) ? level : null;
    return map;
}

export function toPiModel(entry: CatalogEntry): Model<typeof API_ID> {
    const levels = thinkingLevelMap(entry.efforts);
    return {
        id: entry.id,
        name: entry.name,
        api: API_ID,
        provider: PROVIDER_ID,
        baseUrl: MODEL_BASE_URL,
        reasoning: entry.efforts.length > 0,
        ...(levels ? { thinkingLevelMap: levels } : {}),
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
        maxTokens: FALLBACK_MAX_TOKENS,
    };
}

/** Claude Agent chat models from a persisted catalog. */
export function restoreStored(stored: Readonly<ModelsStoreEntry> | undefined): Model<typeof API_ID>[] {
    return (stored?.models ?? []).filter((model): model is Model<typeof API_ID> =>
        isModelType(model, "chat") && model.provider === PROVIDER_ID && model.api === API_ID);
}
