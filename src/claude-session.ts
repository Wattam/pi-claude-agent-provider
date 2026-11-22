import type { UUID } from "node:crypto";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import type {
    AccountInfo, EffortLevel, Options, Query, SDKMessage, SDKRateLimitInfo, SDKResultMessage, SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { deadline, deferred, type Deferred } from "./async.js";
import { INTERRUPT_TIMEOUT_MS } from "./constants.js";
import type { ChildLauncher } from "./io.js";
import { INTERRUPT_TIMEOUT, stopped } from "./messages.js";
import { loadSdk } from "./sdk.js";
import type { ContentBlock } from "./transcript.js";

export interface InitInfo {
    version: string | undefined;
    account: AccountInfo;
}

export interface ClaudeSession {
    readonly id: string;
    readonly query: Query;
    readonly ready: Promise<InitInfo>;
    readonly ended: boolean;
    readonly running: boolean;
    begin(content: ContentBlock[], uuid: string): void;
    addUser(content: ContentBlock[], uuid: string): void;
    readStep(
        onMessage: (message: SDKMessage) => Promise<void>,
        isPiTool: (sdkName: string) => boolean,
    ): Promise<SDKResultMessage | "tools">;
    interrupt(): Promise<void>;
    stop(options?: { discardQueued?: boolean }): Promise<void>;
    setModel(model: string): Promise<void>;
    setEffort(effort: EffortLevel | undefined): Promise<void>;
}

interface Turn {
    readonly drained: Deferred<void>;
    readonly messages: SDKMessage[];
    wake?: () => void;
    finished: boolean;
    interruption?: Promise<void>;
}

export interface SessionObserver {
    rateLimit(info: SDKRateLimitInfo): void;
    /** Claude Code lost transcript lines of this session, so resuming it would drop part of the conversation. */
    transcriptLost(): void;
}

/** Starts one streaming Claude Code process. A single reader loop owns the SDK iterator for the session's life. */
export async function startClaudeSession(
    options: Options,
    observer: SessionObserver,
    launcher: ChildLauncher,
): Promise<ClaudeSession> {
    const { query } = await loadSdk();
    const sessionId = options.resume ?? options.sessionId ?? "";
    let input!: ReadableStreamDefaultController<SDKUserMessage>;
    const prompt = new ReadableStream<SDKUserMessage>({
        start(controller) {
            input = controller;
        },
    });
    const session = query({ prompt, options });
    let turn: Turn | undefined;
    let initialized = false;
    let ended = false;
    let failure: unknown;
    let stopping: Promise<void> | undefined;
    // Additional input can survive the current result. Keep this conservative until the process exits.
    let mayHaveQueuedInput = false;

    const ready = session.initializationResult().then((init): InitInfo => {
        initialized = true;
        return { version: init.claude_code_version, account: init.account };
    });
    // A stop during startup can end the session before anything awaits ready.
    ready.catch(() => undefined);

    function finishTurn(): void {
        if (!turn) return;
        turn.finished = true;
        turn.drained.resolve();
    }

    function endedError(): unknown {
        return failure ?? new Error(stopped(launcher.tail || undefined));
    }

    async function readAll(): Promise<void> {
        try {
            for await (const message of session) {
                // Policy reports must be observed before the first turn exists, while Pi executes tools, and
                // while an interrupted turn drains.
                if (message.type === "rate_limit_event") observer.rateLimit(message.rate_limit_info);
                // Sent once as the CLI exits (Claude Code 2.1.317); it can follow this turn's result.
                if (message.type === "system" && message.subtype === "session_writes_lost"
                    && message.lost.includes("transcript")
                    && (message.transcript_session_ids ?? [sessionId]).includes(sessionId)) {
                    observer.transcriptLost();
                }
                if (turn) {
                    turn.messages.push(message);
                    turn.wake?.();
                }
                if (message.type === "result") finishTurn();
            }
        } catch (error) {
            failure = error;
        } finally {
            ended = true;
            finishTurn();
            turn?.wake?.();
        }
    }
    const pump = readAll();

    function enqueue(content: ContentBlock[], uuid: string, priority?: "next"): void {
        input.enqueue({
            type: "user",
            uuid: uuid as UUID,
            ...(priority ? { priority } : {}),
            message: { role: "user", content },
            parent_tool_use_id: null,
        });
    }

    function interrupt(): Promise<void> {
        const active = turn;
        if (!active || active.finished || ended) return Promise.resolve();
        active.interruption ??= interruptTurn(active);
        return active.interruption;
    }

    async function interruptTurn(active: Turn): Promise<void> {
        try {
            await deadline((async () => {
                await session.interrupt();
                // The control response precedes the result and transcript flush.
                await active.drained.promise;
            })(), INTERRUPT_TIMEOUT_MS, () => {
                throw new Error(INTERRUPT_TIMEOUT);
            });
        } catch (error) {
            // A rejected or stalled interrupt must not leave a reader or shutdown waiting for more output.
            session.close();
            throw error;
        }
    }

    async function shutdown(): Promise<void> {
        try {
            if (initialized && !ended) await interrupt();
        } finally {
            input.close();
            // An uninitialized process has no conversation to flush.
            if (!initialized) session.close();
            try {
                await pump;
            } finally {
                session.close();
            }
        }
    }

    return {
        id: sessionId,
        query: session,
        ready,
        get ended() {
            return ended;
        },
        get running() {
            return !!turn && !turn.finished;
        },
        begin(content, uuid) {
            if (ended || stopping) throw endedError();
            if (turn && !turn.finished) throw new Error("Claude Code is still finishing the previous turn");
            turn = { drained: deferred<void>(), messages: [], finished: false };
            enqueue(content, uuid);
        },
        addUser(content, uuid) {
            if (ended || stopping) throw endedError();
            mayHaveQueuedInput = true;
            enqueue(content, uuid, "next");
        },
        async readStep(onMessage, isPiTool) {
            const active = turn;
            if (!active) throw new Error("No Claude turn to read");
            let calledTools = false;
            while (true) {
                const message = active.messages.shift();
                if (!message) {
                    if (ended) throw endedError();
                    await new Promise<void>((resolve) => {
                        active.wake = resolve;
                    });
                    continue;
                }
                await onMessage(message);
                if (message.type === "assistant" && message.parent_tool_use_id === null) {
                    for (const block of message.message.content) {
                        if (block.type === "tool_use" && isPiTool(block.name)) calledTools = true;
                    }
                }
                const replyEnded = message.type === "stream_event" && message.parent_tool_use_id === null
                    && message.event.type === "message_stop";
                if (calledTools && replyEnded) return "tools";
                if (message.type === "result") return message;
            }
        },
        interrupt,
        stop({ discardQueued } = {}) {
            if (discardQueued && mayHaveQueuedInput && !ended) {
                // Interrupt receipts race the CLI's next queued turn, and SDK close gives stdin EOF a grace
                // period. Kill the child directly before either can allow more inference. Escalate an existing
                // graceful shutdown too, since policy reports can arrive while it drains.
                void interrupt().catch(() => undefined);
                try {
                    launcher.kill();
                } finally {
                    session.close();
                }
            }
            stopping ??= shutdown();
            return stopping;
        },
        setModel: model => session.setModel(model),
        setEffort: effort => session.applyFlagSettings({ effortLevel: effort ?? null }),
    };
}
