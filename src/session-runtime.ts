import { createHash, randomUUID } from "node:crypto";
import type { EffortLevel, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
    toToolDeclaration, type Api, type Model, type SimpleStreamOptions, type Tool, type ToolResultMessage,
    type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { deadline } from "./async.js";
import { startClaudeSession, type ClaudeSession } from "./claude-session.js";
import { IDLE_STOP_MS, PROVIDER_ID, STARTUP_TIMEOUT_MS, TOOL_SERVER_NAME } from "./constants.js";
import { ClaudeStreamConverter } from "./converter.js";
import { ExtraUsageTracker, type ExtraUsageGuard } from "./extra-usage.js";
import { ChildLauncher, childEnv, type ClaudeIO } from "./io.js";
import { readLoginIdentity, type LoginIdentity } from "./login.js";
import {
    ABORTED, ACCOUNT_CHANGED, BRIDGE_FAILED, FORKED, HANDOFF, HISTORY_CHANGED, INVALID_PAYLOAD, INVALID_STATE,
    NO_NEW_INPUT, NOT_INSTALLED, STARTUP_TIMEOUT, TRANSCRIPT_LOST, TRANSCRIPT_MISSING, extraUsageBlocked,
    extraUsageStopped, extraUsageWarning, unsupportedRoute,
} from "./messages.js";
import { baseOptions, sessionOptions } from "./query-options.js";
import { readRecord, type Checkpoint, type ContinuationRecord } from "./record.js";
import type { PiStreamWriter } from "./stream-writer.js";
import { piToolName } from "./tools/names.js";
import { createPendingTools, type PendingTools } from "./tools/pending.js";
import { toCallToolResult } from "./tools/results.js";
import { createToolHooks, createToolServer } from "./tools/server.js";
import { prefixHash, renderInput, renderPlain, type ContentBlock, type ConversationMessage } from "./transcript.js";
import { errorMessage, isObject } from "./values.js";
import { startupError, versionError } from "./version.js";

export interface TurnRequest {
    model: Model<Api>;
    effort: EffortLevel | undefined;
    thinking: "adaptive" | "disabled";
    systemPrompt: string;
    tools: Tool[];
    conversation: ConversationMessage[];
    signal?: AbortSignal;
    onPayload?: SimpleStreamOptions["onPayload"];
    onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
}

export interface RuntimeDeps {
    io: ClaudeIO;
    guard: ExtraUsageGuard;
    piSessionId: string;
    cwd: string;
    sessionManager: ExtensionContext["sessionManager"];
    writeRecord(record: ContinuationRecord): void;
    warn(message: string): void;
}

/** The request body exposed to `before_provider_request` handlers through `onPayload`. */
interface TurnPayload {
    model: string;
    effort: EffortLevel | undefined;
    input: ContentBlock[];
    toolResults: { toolCallId: string; result: CallToolResult }[];
}

interface Live {
    session: ClaudeSession;
    pending: PendingTools;
    launchKey: string;
    accountKey: string;
    model: string;
    effort?: EffortLevel;
    rateLimits: ExtraUsageTracker;
    extraUsageStop?: Promise<void>;
    onExtraUsage?: () => void;
    /** Pi tool-call ids of a turn parked at a Pi tool boundary. */
    waiting?: string[];
}

type GoodCheckpoint = ContinuationRecord["good"];

/** How the request continues the chat's native Claude session. */
interface ContinuationPlan {
    record?: ContinuationRecord;
    /** Prefix ending at the last successful native turn. */
    good: GoodCheckpoint;
    /** Messages after the prefix the native session holds. */
    unseen: ConversationMessage[];
    rollback: boolean;
}

const EMPTY: Checkpoint = { count: 0, hash: "" };

function checkpoint(messages: readonly ConversationMessage[]): Checkpoint {
    return { count: messages.length, hash: prefixHash(messages, messages.length) };
}

/** A replacement payload must keep the original's form: content blocks and results for the same tool calls. */
function isPayloadLike(value: unknown, original: TurnPayload): value is TurnPayload {
    if (!isObject(value) || !Array.isArray(value.input) || !Array.isArray(value.toolResults)) return false;
    if (!value.input.every(block => isObject(block) && typeof block.type === "string")) return false;
    const results: unknown[] = value.toolResults;
    return results.length === original.toolResults.length && results.every((entry, index) =>
        isObject(entry) && entry.toolCallId === original.toolResults[index].toolCallId
        && isObject(entry.result) && Array.isArray(entry.result.content));
}

/**
 * Owns the Claude Code process of one Pi session. Requests run one at a time; a turn that stops at a Pi tool
 * boundary stays parked until the next request delivers Pi's results or the agent settles.
 */
export class SessionRuntime {
    private live: Live | undefined;
    private queue: Promise<void> = Promise.resolve();
    private idle: ReturnType<typeof setTimeout> | undefined;
    private closed = false;
    private shutdownDone: Promise<void> | undefined;
    /** Claude session ids whose transcript lost lines; resuming one would drop part of the conversation. */
    private readonly lostTranscripts = new Set<string>();

    constructor(private readonly deps: RuntimeDeps) {}

    run(request: TurnRequest, writer: PiStreamWriter): Promise<void> {
        return this.exclusive(async () => {
            this.clearIdle();
            try {
                await this.turn(request, writer);
            } finally {
                if (this.live && !this.live.waiting) this.armIdle();
            }
        });
    }

    /** Interrupts a parked tool turn once Pi's agent loop has ended without delivering its results. */
    settle(): Promise<void> {
        return this.exclusive(async () => {
            if (!this.live) return;
            await this.releaseWaiting(this.live);
            this.armIdle();
        });
    }

    shutdown(): Promise<void> {
        this.closed = true;
        this.clearIdle();
        this.shutdownDone ??= this.exclusive(async () => {
            if (this.live) await this.releaseWaiting(this.live);
            await this.stopLive();
        });
        return this.shutdownDone;
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(work);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private clearIdle(): void {
        if (this.idle !== undefined) clearTimeout(this.idle);
        this.idle = undefined;
    }

    private armIdle(): void {
        this.clearIdle();
        if (this.closed) return;
        this.idle = setTimeout(() => {
            this.idle = undefined;
            void this.exclusive(() => this.stopLive()).catch(() => undefined);
        }, IDLE_STOP_MS);
        this.idle.unref();
    }

    private async stopLive(): Promise<void> {
        const live = this.live;
        if (!live) return;
        this.live = undefined;
        try {
            await live.session.stop();
        } catch {
            // The process is already closed or unresponsive; dropping it is all that is left to do.
        } finally {
            live.pending.clear();
        }
    }

    /** Interrupt-and-drain a parked turn before cancelling its waiting tool calls. */
    private async releaseWaiting(live: Live): Promise<void> {
        if (live.waiting) await this.drainTurn(live);
    }

    /** Interrupt-and-drain the running turn, then cancel its tool calls so no waiting call starts another model call. */
    private async drainTurn(live: Live): Promise<void> {
        let drained = true;
        try {
            await live.session.interrupt();
        } catch {
            // A rejected or timed-out interrupt has closed the process without draining it.
            drained = false;
        } finally {
            live.pending.clear();
            live.waiting = undefined;
        }
        if (!drained) await this.stopLive();
    }

    private fail(request: TurnRequest, writer: PiStreamWriter, message: string): void {
        if (request.signal?.aborted) writer.fail("aborted", ABORTED);
        else writer.fail("error", message);
    }

    /** Observes policy reports for the entire native turn, including parked tools and cleanup. */
    private rateLimit(live: Live, info: SDKRateLimitInfo): void {
        live.rateLimits.accept(info);
        const extraUsage = live.rateLimits.extraUsage;
        if (!extraUsage) return;
        this.deps.guard.record(live.accountKey, extraUsage.resetsAt);
        if (live.extraUsageStop) return;
        // Stop outside the request queue: an active read or parked tool cannot gate the billing policy.
        live.extraUsageStop = live.session.stop({ discardQueued: true })
            .finally(() => live.pending.clear()).catch(() => undefined);
        live.onExtraUsage?.();
        this.deps.warn(extraUsageWarning());
    }

    private transcriptLost(sessionId: string): void {
        if (this.lostTranscripts.has(sessionId)) return;
        this.lostTranscripts.add(sessionId);
        this.deps.warn(TRANSCRIPT_LOST);
    }

    private async turn(request: TurnRequest, writer: PiStreamWriter): Promise<void> {
        let prepared: { live: Live; plan: ContinuationPlan; identity: LoginIdentity; latestRevision: number };
        try {
            prepared = await this.prepare(request);
        } catch (error) {
            this.fail(request, writer, errorMessage(error));
            return;
        }
        await this.exchange(request, writer, prepared.live, prepared.plan, prepared.identity, prepared.latestRevision);
    }

    /** Steps before any input reaches Claude: login, extra-usage block, continuation plan, process, controls. */
    private async prepare(
        request: TurnRequest,
    ): Promise<{ live: Live; plan: ContinuationPlan; identity: LoginIdentity; latestRevision: number }> {
        const { io } = this.deps;
        const { signal } = request;
        signal?.throwIfAborted();
        const executable = io.which();
        if (!executable) throw new Error(NOT_INSTALLED);
        const env = childEnv(io.env());
        const identity = await readLoginIdentity(io, executable, env, signal);
        if (this.live && this.live.accountKey !== identity.accountKey) await this.stopLive();
        this.requireUnblocked(identity.accountKey);
        const state = readRecord(this.deps.sessionManager);
        const plan = this.plan(request.conversation, state, identity.accountKey);
        const live = await this.ensureLive(request, plan, executable, env, identity);
        if (live.model !== request.model.id) {
            await live.session.setModel(request.model.id);
            live.model = request.model.id;
        }
        if (live.effort !== request.effort) {
            await live.session.setEffort(request.effort);
            live.effort = request.effort;
        }
        return { live, plan, identity, latestRevision: state.latestRevision };
    }

    /** Refuses the request while the guard holds the account blocked for extra usage. */
    private requireUnblocked(accountKey: string): void {
        const block = this.deps.guard.blocked(accountKey);
        if (block) throw new Error(extraUsageBlocked(block.resetsAt));
    }

    private plan(
        conversation: readonly ConversationMessage[],
        state: ReturnType<typeof readRecord>,
        accountKey: string,
    ): ContinuationPlan {
        const { record, invalid, latestRevision } = state;
        if (invalid) throw new Error(INVALID_STATE);
        if (!record) {
            if (conversation.some(message => message.role !== "user")) throw new Error(HANDOFF);
            return { good: EMPTY, unseen: [...conversation], rollback: false };
        }
        if (record.piSessionId !== this.deps.piSessionId) throw new Error(FORKED);
        if (record.revision < latestRevision) throw new Error(HISTORY_CHANGED);
        if (record.accountKey !== accountKey) throw new Error(ACCOUNT_CHANGED);
        if (this.lostTranscripts.has(record.claudeSessionId)) throw new Error(TRANSCRIPT_LOST);
        const base = record.failed ? record.good : record.seen;
        if (conversation.length < base.count || prefixHash(conversation, base.count) !== base.hash) {
            throw new Error(HISTORY_CHANGED);
        }
        const unseen = conversation.slice(base.count);
        const replies = unseen.filter(message => message.role === "assistant");
        if (replies.some(message => message.provider !== PROVIDER_ID)) throw new Error(HANDOFF);
        if (replies.length > 0 && !record.failed) throw new Error(HISTORY_CHANGED);
        if (unseen.length === 0) throw new Error(NO_NEW_INPUT);
        return { record, good: record.good, unseen, rollback: record.failed };
    }

    /** Reuses the live process when it serves this request unchanged; otherwise starts Claude Code at the plan. */
    private async ensureLive(
        request: TurnRequest,
        plan: ContinuationPlan,
        executable: string,
        env: Record<string, string>,
        identity: LoginIdentity,
    ): Promise<Live> {
        const { io, cwd } = this.deps;
        const launchKey = createHash("sha256")
            .update(JSON.stringify([request.systemPrompt, request.tools.map(toToolDeclaration), request.thinking]))
            .digest("hex");
        const current = this.live;
        if (current && (current.session.ended || current.launchKey !== launchKey
            || current.session.id !== plan.record?.claudeSessionId || plan.rollback)) {
            await this.releaseWaiting(current);
            await this.stopLive();
        }
        // Draining a replaced process can reveal extra usage after prepare's initial account check.
        this.requireUnblocked(identity.accountKey);
        if (this.live) return this.live;
        const start = this.startPoint(plan, request.conversation);
        const claudeSessionId = "resume" in start ? start.resume : start.sessionId;
        if ("resume" in start && !(await io.sessionExists(start.resume, cwd))) throw new Error(TRANSCRIPT_MISSING);
        const pending = createPendingTools();
        const toolServer = request.tools.length ? createToolServer(request.tools, pending) : undefined;
        const launcher = new ChildLauncher(io.spawn);
        const session = await startClaudeSession(sessionOptions({
            base: baseOptions(executable, env, launcher.launch),
            cwd,
            model: request.model.id,
            effort: request.effort,
            thinking: request.thinking,
            systemPrompt: request.systemPrompt,
            hooks: createToolHooks(pending),
            toolServer,
            start,
        }), {
            rateLimit: info => this.rateLimit(live, info),
            transcriptLost: () => this.transcriptLost(claudeSessionId),
        }, launcher);
        // The reader loop reports only from its own task, so `live` must exist before this function awaits again.
        const live: Live = {
            session, pending, launchKey, accountKey: identity.accountKey, model: request.model.id,
            effort: request.effort, rateLimits: new ExtraUsageTracker(),
        };
        try {
            const init = await deadline(session.ready, STARTUP_TIMEOUT_MS, () => {
                throw new Error(STARTUP_TIMEOUT);
            }, request.signal);
            const outdated = versionError(init.version);
            if (outdated) throw new Error(outdated);
            const { apiProvider, apiKeySource, tokenSource } = init.account;
            if ((apiProvider !== undefined && apiProvider !== "firstParty")
                || (apiKeySource !== undefined && apiKeySource !== "none")
                || tokenSource === "none") {
                throw new Error(unsupportedRoute(apiProvider ?? apiKeySource ?? "unknown"));
            }
            // Startup itself can report extra usage, which blocks the account before any input is sent.
            this.requireUnblocked(identity.accountKey);
        } catch (error) {
            await session.stop();
            // A startup report stops the process mid-handshake, so the block is the real cause of that failure.
            this.requireUnblocked(identity.accountKey);
            throw new Error(startupError(errorMessage(error)));
        }
        this.live = live;
        return live;
    }

    /** Where a new process starts; a rollback without a successful reply starts over with the whole conversation. */
    private startPoint(
        plan: ContinuationPlan,
        conversation: readonly ConversationMessage[],
    ): { sessionId: string } | { resume: string; resumeSessionAt?: string } {
        const { record } = plan;
        if (!record) return { sessionId: randomUUID() };
        if (!plan.rollback) return { resume: record.claudeSessionId };
        if (record.good.claudeMessageId) {
            return { resume: record.claudeSessionId, resumeSessionAt: record.good.claudeMessageId };
        }
        plan.good = EMPTY;
        plan.unseen = [...conversation];
        return { sessionId: randomUUID() };
    }

    /** Sends the request's input, reads Claude's reply up to a Pi tool boundary or result, and records the outcome. */
    private async exchange(
        request: TurnRequest,
        writer: PiStreamWriter,
        live: Live,
        plan: ContinuationPlan,
        identity: LoginIdentity,
        latestRevision: number,
    ): Promise<void> {
        const { conversation, tools, signal } = request;
        const revision = Math.max(plan.record?.revision ?? 0, latestRevision) + 1;
        const write = (seen: Checkpoint, failed: boolean, good: GoodCheckpoint = plan.good): void => {
            // A late billing report must invalidate the checkpoint even while shutdown drains the turn.
            if (this.closed && !failed) return;
            this.deps.writeRecord({
                version: 1, piSessionId: this.deps.piSessionId, revision, claudeSessionId: live.session.id,
                accountKey: identity.accountKey, seen, good, failed,
            });
        };
        let inputSent = false;
        const seenAfterInput = checkpoint(conversation);
        const converter = new ClaudeStreamConverter(writer, tools, request.model);
        let aborted = false;
        // Keep the failed checkpoint current even if detection follows this stream's terminal tool boundary.
        live.onExtraUsage = () => write(seenAfterInput, true);
        const interrupt = (): void => {
            live.session.interrupt().catch(() => undefined);
        };
        const onAbort = (): void => {
            aborted = true;
            interrupt();
        };
        try {
            await this.sendInput(request, writer, live, plan.unseen);
            inputSent = true;
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
            const outcome = await live.session.readStep(async (message: SDKMessage) => {
                await request.onProviderStreamEvent?.(message, request.model);
                if (message.type === "system" && message.subtype === "init" && tools.length > 0
                    && !message.mcp_servers.some(server =>
                        server.name === TOOL_SERVER_NAME && server.status === "connected")) {
                    throw new Error(BRIDGE_FAILED);
                }
                converter.accept(message);
                if (message.type === "assistant" && message.parent_tool_use_id === null && !message.error) {
                    for (const block of message.message.content) {
                        if (block.type === "tool_use" && piToolName(block.name, tools) !== undefined) {
                            live.pending.expect(block.id, block.name);
                        }
                    }
                }
            }, name => piToolName(name, tools) !== undefined);
            converter.finishUsage();
            if (live.extraUsageStop) {
                await live.extraUsageStop;
                writer.fail("error", extraUsageStopped(live.rateLimits.extraUsage?.resetsAt));
                await this.stopLive();
            } else if (aborted) {
                write(seenAfterInput, false);
                writer.fail("aborted", ABORTED);
                await this.drainTurn(live);
            } else if (outcome === "tools") {
                write(checkpoint([...conversation, writer.output]), false);
                writer.done("toolUse");
                live.waiting = converter.piToolCallIds;
            } else {
                const failure = converter.failure(outcome);
                if (failure !== undefined) {
                    write(seenAfterInput, true);
                    writer.fail("error", failure);
                    await this.stopLive();
                } else {
                    const seen = checkpoint([...conversation, writer.output]);
                    const messageId = converter.lastAssistantUuid;
                    write(seen, false, messageId ? { ...seen, claudeMessageId: messageId } : seen);
                    writer.done(outcome.stop_reason === "max_tokens" ? "length" : "stop");
                }
            }
        } catch (error) {
            converter.finishUsage();
            if (live.extraUsageStop) {
                await live.extraUsageStop;
                writer.fail("error", extraUsageStopped(live.rateLimits.extraUsage?.resetsAt));
            } else {
                if (inputSent) write(seenAfterInput, true);
                this.fail(request, writer, errorMessage(error));
            }
            await this.stopLive();
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    /**
     * Delivers Pi's tool results into a parked turn when they answer exactly its waiting calls; otherwise begins a
     * new native turn with every unseen message.
     */
    private async sendInput(
        request: TurnRequest,
        writer: PiStreamWriter,
        live: Live,
        unseen: readonly ConversationMessage[],
    ): Promise<void> {
        let payload: TurnPayload | undefined;
        if (live.waiting) {
            const waiting = live.waiting;
            const split = unseen.findIndex(message => message.role !== "toolResult");
            const results = (split === -1 ? unseen : unseen.slice(0, split)) as ToolResultMessage[];
            const rest = split === -1 ? [] : unseen.slice(split);
            const answered = waiting.every(id => results.filter(result => result.toolCallId === id).length === 1)
                && results.every(result => waiting.includes(result.toolCallId))
                && rest.every(message => message.role === "user");
            if (answered) {
                payload = {
                    model: request.model.id,
                    effort: request.effort,
                    input: renderPlain(rest as UserMessage[]),
                    toolResults: results.map(result => ({
                        toolCallId: result.toolCallId, result: toCallToolResult(result),
                    })),
                };
            } else {
                await this.releaseWaiting(live);
            }
        }
        payload ??= {
            model: request.model.id, effort: request.effort, input: renderInput(unseen), toolResults: [],
        };
        const replacement = await request.onPayload?.(payload, request.model);
        if (replacement !== undefined) {
            if (!isPayloadLike(replacement, payload)) throw new Error(INVALID_PAYLOAD);
            payload = replacement;
        }
        request.signal?.throwIfAborted();
        // A report may arrive during tool cleanup or an awaited payload hook, after prepare checked the guard.
        this.requireUnblocked(live.accountKey);
        writer.start();
        if (live.waiting) {
            if (payload.input.length > 0) live.session.addUser(payload.input, randomUUID());
            for (const { toolCallId, result } of payload.toolResults) live.pending.resolve(toolCallId, result);
            live.waiting = undefined;
        } else {
            live.rateLimits = new ExtraUsageTracker();
            live.session.begin(payload.input, randomUUID());
        }
    }
}
