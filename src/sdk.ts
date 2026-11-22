import { SDK_MISSING } from "./messages.js";

export type ClaudeSdk = typeof import("@anthropic-ai/claude-agent-sdk");

let loading: Promise<ClaudeSdk> | undefined;

/** Loads the Agent SDK on first use so Pi starts without it; a failed import is retried on the next call. */
export function loadSdk(): Promise<ClaudeSdk> {
    loading ??= import("@anthropic-ai/claude-agent-sdk").catch((cause: unknown) => {
        loading = undefined;
        throw new Error(SDK_MISSING, { cause });
    });
    return loading;
}
