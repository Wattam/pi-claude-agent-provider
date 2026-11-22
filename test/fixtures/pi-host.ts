import type { TestContext } from "node:test";
import {
    normalizeContext,
    type AssistantMessage,
    type AssistantMessageEvent,
    type Message,
    type Model,
    type Provider,
    type SimpleStreamOptions,
    type Tool,
    type ToolCall,
    type ToolResultMessage,
    type UserMessage,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toPiModel } from "../../src/catalog.js";
import { STATE_ENTRY_TYPE } from "../../src/constants.js";
import { registerClaudeAgent } from "../../src/extension.js";
import type { ClaudeIO } from "../../src/io.js";
import type { ContinuationRecord } from "../../src/record.js";
import { FakeClaude } from "./fake-claude.js";

// The extension keeps the extra-usage guard on globalThis under this key for the Pi process lifetime.
export const GUARD_KEY = Symbol.for("claude-agent-provider.extra-usage-guard");
export const CWD = "/work/project";

export const SONNET = toPiModel({
    id: "sonnet", name: "Sonnet", efforts: ["low", "medium", "high"], contextWindow: 200_000,
});
export const OPUS = toPiModel({ id: "opus", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] });
export const READ_TOOL: Tool = {
    name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }),
};
export const BASH_TOOL: Tool = {
    name: "bash", description: "Run a shell command", parameters: Type.Object({ command: Type.String() }),
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface Notification {
    message: string;
    type: string | undefined;
}

/** Simulates one Pi process: factory runs, lifecycle events, provider registration, and session entries. */
export class PiHost {
    readonly notifications: Notification[] = [];
    provider!: Provider;
    providerRegistrations = 0;
    private handlers = new Map<string, Handler[]>();

    constructor(
        readonly io: ClaudeIO,
        public sessionManager: SessionManager = SessionManager.inMemory(CWD),
        public hasUI = true,
    ) {}

    /** Forget process-scoped state, as a fresh Pi process would. */
    static newProcess(): void {
        delete (globalThis as Record<symbol, unknown>)[GUARD_KEY];
    }

    load(): void {
        this.handlers = new Map();
        const pi = {
            registerProvider: (provider: Provider) => {
                this.provider = provider;
                this.providerRegistrations++;
            },
            on: (name: string, handler: Handler) => {
                this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
                return () => undefined;
            },
            appendEntry: (customType: string, data?: unknown) => {
                this.sessionManager.appendCustomEntry(customType, data);
            },
        } as unknown as ExtensionAPI;
        registerClaudeAgent(pi, this.io);
    }

    context(model?: Model<string>): ExtensionContext {
        return {
            sessionManager: this.sessionManager,
            cwd: CWD,
            hasUI: this.hasUI,
            model,
            ui: { notify: (message: string, type?: string) => this.notifications.push({ message, type }) },
        } as unknown as ExtensionContext;
    }

    handlerCount(name: string): number {
        return this.handlers.get(name)?.length ?? 0;
    }

    async emit(name: string, event: object, model?: Model<string>): Promise<unknown[]> {
        const results: unknown[] = [];
        for (const handler of this.handlers.get(name) ?? []) {
            results.push(await handler({ type: name, ...event }, this.context(model)));
        }
        return results;
    }

    async start(reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup"): Promise<void> {
        this.load();
        await this.emit("session_start", { reason });
    }

    async shutdown(): Promise<void> {
        await this.emit("session_shutdown", {});
    }

    async reload(): Promise<void> {
        await this.shutdown();
        await this.start("reload");
    }

    async switchSession(reason: "new" | "resume" | "fork", sessionManager: SessionManager): Promise<void> {
        await this.shutdown();
        this.sessionManager = sessionManager;
        await this.start(reason);
    }

    get records(): ContinuationRecord[] {
        return this.sessionManager.getEntries()
            .filter(entry => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
            .map(entry => (entry as { data: ContinuationRecord }).data);
    }

    get warnings(): string[] {
        return this.notifications.filter(note => note.type === "warning").map(note => note.message);
    }
}

export interface PiFixture {
    fake: FakeClaude;
    host: PiHost;
    chat: Chat;
}

/** Starts a fresh Pi process with one session and shuts it down after the test. */
export async function startPi(
    t: TestContext,
    options: { fake?: FakeClaude; io?: ClaudeIO; hasUI?: boolean } = {},
): Promise<PiFixture> {
    PiHost.newProcess();
    const fake = options.fake ?? new FakeClaude();
    const host = new PiHost(options.io ?? fake.io(), SessionManager.inMemory(CWD), options.hasUI ?? true);
    await host.start();
    t.after(() => host.shutdown());
    return { fake, host, chat: new Chat(host) };
}

export interface StreamRun {
    events: AssistantMessageEvent[];
    message: AssistantMessage;
}

/** One Pi chat transcript sent through the provider the way Pi's agent loop sends it. */
export class Chat {
    readonly messages: Message[] = [];
    systemPrompt = "You are Pi. Follow the loaded AGENTS.md and CLAUDE.md instructions.";
    tools: Tool[] = [READ_TOOL];
    model: Model<string> = SONNET;

    constructor(readonly host: PiHost) {}

    user(content: UserMessage["content"]): this {
        this.messages.push({ role: "user", content, timestamp: Date.now() });
        return this;
    }

    toolResult(call: ToolCall, text: string, isError = false): this {
        const message: ToolResultMessage = {
            role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{ type: "text", text }], isError, timestamp: Date.now(),
        };
        this.messages.push(message);
        return this;
    }

    start(options: SimpleStreamOptions = {}, onEvent?: (event: AssistantMessageEvent) => void): Promise<StreamRun> {
        const { systemPrompt, tools, messages } = this;
        const context = normalizeContext({ systemPrompt, tools, messages });
        const stream = this.host.provider.streamSimple(this.model, context, {
            sessionId: this.host.sessionManager.getSessionId(), ...options,
        });
        return (async (): Promise<StreamRun> => {
            const events: AssistantMessageEvent[] = [];
            for await (const event of stream) {
                events.push(event);
                onEvent?.(event);
            }
            const message = await stream.result();
            this.messages.push(message);
            return { events, message };
        })();
    }

    send(options: SimpleStreamOptions = {}): Promise<StreamRun> {
        return this.start(options);
    }

    ask(text: string, options: SimpleStreamOptions = {}): Promise<StreamRun> {
        return this.user(text).send(options);
    }
}

export function terminalEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
    return events.filter(event => event.type === "done" || event.type === "error");
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
    return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

export function textOf(message: AssistantMessage): string {
    return message.content.map(block => block.type === "text" ? block.text : "").join("");
}

export interface CapturedTimer {
    readonly callback: () => void;
    cleared: boolean;
}

/** Captures global timers armed with exactly `delay` ms so a test can fire them; other timers run normally. */
export function captureTimers(t: TestContext, delay: number): { active(): CapturedTimer[]; fire(): void } {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const captured = new Map<object, CapturedTimer>();
    type Callback = (...args: unknown[]) => void;
    t.mock.method(globalThis, "setTimeout", ((callback: Callback, ms?: number, ...args: unknown[]) => {
        if (ms !== delay) return realSet(callback, ms, ...args);
        const handle: Record<string | symbol, unknown> = {};
        Object.assign(handle, {
            unref: () => handle, ref: () => handle, refresh: () => handle, hasRef: () => false,
            [Symbol.toPrimitive]: () => -1,
        });
        captured.set(handle, { callback: () => callback(...args), cleared: false });
        return handle;
    }) as unknown as typeof setTimeout);
    t.mock.method(globalThis, "clearTimeout", ((handle?: unknown) => {
        const timer = typeof handle === "object" && handle !== null ? captured.get(handle) : undefined;
        if (timer) timer.cleared = true;
        else realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout);
    const active = (): CapturedTimer[] => [...captured.values()].filter(timer => !timer.cleared);
    return {
        active,
        fire: () => {
            for (const timer of active()) {
                timer.cleared = true;
                timer.callback();
            }
        },
    };
}

/** Polls until `condition` holds; fails after `timeoutMs`. */
export async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error("Condition not reached");
        await new Promise(resolve => setImmediate(resolve));
    }
}
