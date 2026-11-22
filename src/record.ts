import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY_TYPE } from "./constants.js";
import { isObject } from "./values.js";

export interface Checkpoint {
    count: number;
    hash: string;
}

/** Per-chat continuation state, appended as a `claude-agent-state` session entry after each native turn. */
export interface ContinuationRecord {
    version: 1;
    piSessionId: string;
    revision: number;
    claudeSessionId: string;
    /** SHA-256 digest from readLoginIdentity. */
    accountKey: string;
    /** Conversation prefix the native session has received. */
    seen: Checkpoint;
    /** Prefix ending at the last successful native turn. */
    good: Checkpoint & { claudeMessageId?: string };
    /** Last native turn ended with an error result or crash. */
    failed: boolean;
}

type SessionManager = ExtensionContext["sessionManager"];

function isCount(value: unknown): boolean {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCheckpoint(value: unknown): value is Checkpoint {
    return isObject(value) && isCount(value.count) && typeof value.hash === "string"
        && (value.hash === "" || /^[0-9a-f]{64}$/.test(value.hash));
}

function isRecord(value: unknown): value is ContinuationRecord {
    return isObject(value)
        && value.version === 1
        && typeof value.piSessionId === "string"
        && isCount(value.revision)
        && typeof value.claudeSessionId === "string"
        && typeof value.accountKey === "string"
        && isCheckpoint(value.seen)
        && isCheckpoint(value.good)
        && ["undefined", "string"].includes(typeof (value.good as { claudeMessageId?: unknown }).claudeMessageId)
        && typeof value.failed === "boolean";
}

function stateEntries(entries: ReturnType<SessionManager["getEntries"]>): { data?: unknown }[] {
    return entries.flatMap(entry => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE ? [entry] : []);
}

/**
 * The current branch's continuation record. `latestRevision` spans every branch of the same Claude session, so
 * navigating back to an older branch exposes a stale revision.
 */
export function readRecord(
    sessionManager: SessionManager,
): { record?: ContinuationRecord; invalid: boolean; latestRevision: number } {
    const current = stateEntries(sessionManager.getBranch()).at(-1);
    if (!current) return { record: undefined, invalid: false, latestRevision: 0 };
    const data = current.data;
    if (!isRecord(data)) return { record: undefined, invalid: true, latestRevision: 0 };
    let latestRevision = data.revision;
    for (const { data: other } of stateEntries(sessionManager.getEntries())) {
        if (isRecord(other) && other.claudeSessionId === data.claudeSessionId) {
            latestRevision = Math.max(latestRevision, other.revision);
        }
    }
    return { record: data, invalid: false, latestRevision };
}
