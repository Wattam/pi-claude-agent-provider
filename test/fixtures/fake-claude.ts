import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { AccountInfo, ModelInfo, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeIO } from "../../src/io.js";

// Controlled stand-in for the `claude` CLI. It speaks the SDK stream-json stdio protocol, so the real
// Agent SDK, MCP bridge, and hooks run unchanged between the adapter and this fixture.

export const EXECUTABLE = "/fake/bin/claude";
const TOOL_PREFIX = "mcp__pi__";

type Json = Record<string, unknown>;

export interface FakeAuth {
    loggedIn: boolean;
    authMethod?: string;
    apiProvider?: string;
    email?: string;
    orgId?: string;
    orgName?: string;
}

export type FakeBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: Json };

export interface FakeTokens {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

export interface AssistantOptions {
    usage?: FakeTokens;
    stopReason?: string;
    stream?: boolean;
    messageId?: string;
}

export interface FakeUserMessage {
    type: "user";
    uuid?: string;
    priority?: string;
    message: { role: "user"; content: string | Json[] };
}

export interface ToolCallRecord {
    id: string;
    name: string;
    arguments: Json;
    result: CallToolResult;
}

export const DEFAULT_MODELS: ModelInfo[] = [
    { value: "default", displayName: "Default (recommended)", description: "Account default" },
    {
        value: "opus", displayName: "Opus", description: "Most capable", supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
        value: "sonnet", displayName: "Sonnet", description: "Everyday", supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
    },
];

export interface Identity {
    email: string;
    orgId: string;
    organization: string;
}

export const ACCOUNT_A: Identity = { email: "ada@example.test", orgId: "org-a", organization: "Org A" };
export const ACCOUNT_B: Identity = { email: "ben@example.test", orgId: "org-b", organization: "Org B" };

export class FakeClaude {
    auth: FakeAuth = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
    account: AccountInfo = { subscriptionType: "Claude Team", apiProvider: "firstParty" };
    version: string | undefined = "2.1.317";
    models: ModelInfo[] = DEFAULT_MODELS;
    contextWindows: Record<string, number | "error"> = { opus: 1_000_000, sonnet: 200_000 };
    bridgeStatus = "connected";
    /** Claude Code 2.1.317 and later honor `onFailure` on hook matchers; the SDK refuses a session without it. */
    hookOnFailure = true;
    authFailure: Error | undefined;
    interruptFailure: Error | undefined;
    queueAdditionalInput = false;
    onInterrupt: ((turn: FakeTurn | undefined) => Promise<void>) | undefined;
    /** Runs while the CLI handles `initialize`, so anything written lands before the init response. */
    onInitialize: ((child: FakeProcess) => void) | undefined;
    onTurn: (turn: FakeTurn) => Promise<void> = async (turn) => {
        await turn.reply("ok");
    };
    readonly processes: FakeProcess[] = [];
    readonly sessions = new Set<string>();
    authStatusCalls = 0;

    constructor(identity: Identity = ACCOUNT_A) {
        this.login(identity);
    }

    login(identity: Identity): void {
        this.auth = { ...this.auth, email: identity.email, orgId: identity.orgId, orgName: identity.organization };
        this.account = { ...this.account, email: identity.email, organization: identity.organization };
    }

    io(overrides: Partial<ClaudeIO> = {}): ClaudeIO {
        return {
            which: () => EXECUTABLE,
            env: () => ({
                PATH: "/usr/bin", HOME: "/home/fixture", ANTHROPIC_API_KEY: "sk-ant-fixture",
                ANTHROPIC_BASE_URL: "https://gateway.invalid", CLAUDE_CODE_USE_BEDROCK: "1",
                CLAUDE_CODE_OAUTH_TOKEN: "oauth-fixture",
            }),
            spawn: (options: SpawnOptions) => this.spawn(options),
            authStatus: async () => {
                this.authStatusCalls++;
                if (this.authFailure) throw this.authFailure;
                return { stdout: JSON.stringify(this.auth), stderr: "", exitCode: 0 };
            },
            sessionExists: async (sessionId: string) => this.sessions.has(sessionId),
            ...overrides,
        };
    }

    spawn(options: SpawnOptions): SpawnedProcess {
        const child = new FakeProcess(this, options);
        this.processes.push(child);
        return child as unknown as SpawnedProcess;
    }

    get sessionProcesses(): FakeProcess[] {
        return this.processes.filter(child => child.persist);
    }

    get running(): FakeProcess[] {
        return this.processes.filter(child => !child.exited);
    }

    get userMessages(): FakeUserMessage[] {
        return this.processes.flatMap(child => child.userMessages);
    }
}

export class FakeProcess extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    killed = false;
    exited = false;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly flags = new Map<string, string>();
    readonly controlRequests: Json[] = [];
    readonly userMessages: FakeUserMessage[] = [];
    readonly turns: FakeTurn[] = [];
    readonly toolCalls: ToolCallRecord[] = [];
    readonly hookInputs: Json[] = [];
    readonly assistantUuids: string[] = [];
    listedTools: { name: string; description?: string; inputSchema?: unknown; _meta?: Json }[] = [];
    initialize: Json | undefined;
    model: string | undefined;
    private nextRequest = 0;
    private nextMcp = 0;
    private readonly pending = new Map<string, { resolve(value: Json): void; reject(error: Error): void }>();
    private mcpReady: Promise<void> = Promise.resolve();
    private readonly queue: FakeUserMessage[] = [];
    private draining = false;
    current: FakeTurn | undefined;

    constructor(readonly fake: FakeClaude, readonly options: SpawnOptions) {
        super();
        for (const arg of options.args) {
            const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg);
            if (match) this.flags.set(match[1], match[2] ?? "");
        }
        this.model = this.flags.get("model");
        createInterface({ input: this.stdin }).on("line", line => this.receive(line));
        this.stdin.on("end", () => this.exit(0, null));
    }

    get sessionId(): string | undefined {
        return this.flags.get("session-id") ?? this.flags.get("resume");
    }

    get persist(): boolean {
        return !this.flags.has("no-session-persistence");
    }

    get systemPrompt(): string | undefined {
        const prompt = this.initialize?.systemPrompt;
        return Array.isArray(prompt) ? prompt.join("") : typeof prompt === "string" ? prompt : undefined;
    }

    requests(subtype: string): Json[] {
        return this.controlRequests.filter(request => request.subtype === subtype);
    }

    kill(signal: NodeJS.Signals): boolean {
        this.killed = true;
        this.exit(null, signal);
        return true;
    }

    write(message: Json): void {
        if (!this.exited) this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    request(body: Json): Promise<Json> {
        const id = `cli_${++this.nextRequest}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ type: "control_request", request_id: id, request: body });
        });
    }

    async mcp(method: string, params: Json): Promise<Json> {
        const response = await this.request({
            subtype: "mcp_message", server_name: "pi", message: { jsonrpc: "2.0", id: ++this.nextMcp, method, params },
        });
        const reply = response.mcp_response as { result?: Json; error?: { message: string } };
        if (reply.error) throw new Error(reply.error.message);
        return reply.result ?? {};
    }

    private receive(line: string): void {
        let message: Json;
        try {
            message = JSON.parse(line) as Json;
        } catch {
            return;
        }
        if (message.type === "control_request") void this.answer(message.request_id as string, message.request as Json);
        else if (message.type === "control_response") this.settle(message.response as Json);
        else if (message.type === "user") this.accept(message as unknown as FakeUserMessage);
    }

    private settle(response: Json): void {
        const waiter = this.pending.get(response.request_id as string);
        if (!waiter) return;
        this.pending.delete(response.request_id as string);
        if (response.subtype === "success") waiter.resolve((response.response as Json | undefined) ?? {});
        else waiter.reject(new Error(String(response.error)));
    }

    private async answer(id: string, request: Json): Promise<void> {
        this.controlRequests.push(request);
        try {
            const response = await this.handle(request);
            this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
        } catch (error) {
            this.write({
                type: "control_response",
                response: { subtype: "error", request_id: id, error: (error as Error).message },
            });
        }
    }

    private async handle(request: Json): Promise<Json> {
        switch (request.subtype) {
            case "initialize": {
                this.initialize = request;
                this.fake.onInitialize?.(this);
                const servers = (request.sdkMcpServers as string[] | undefined) ?? [];
                if (servers.includes("pi")) {
                    this.mcpReady = new Promise<void>(resolve => setImmediate(resolve))
                        .then(() => this.connectMcp())
                        .catch(() => undefined);
                }
                return {
                    commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
                    models: this.fake.models, account: this.fake.account,
                    ...(this.fake.hookOnFailure ? { hook_on_failure_supported: true, hooks_applied: true } : {}),
                    ...(this.fake.version === undefined ? {} : { claude_code_version: this.fake.version }),
                };
            }
            case "interrupt":
                if (this.fake.interruptFailure) throw this.fake.interruptFailure;
                if (this.fake.onInterrupt) await this.fake.onInterrupt(this.current);
                else this.current?.abort();
                return { still_queued: this.queue.map(message => message.uuid).filter(Boolean) };
            case "set_model":
                this.model = request.model as string | undefined;
                return {};
            case "get_context_usage": {
                const window = this.fake.contextWindows[this.model ?? ""];
                if (window === undefined || window === "error") throw new Error("Context usage unavailable");
                return {
                    categories: [], totalTokens: 0, maxTokens: window, rawMaxTokens: window,
                    percentage: 0, gridRows: [], model: this.model ?? "",
                };
            }
            default:
                return {};
        }
    }

    private async connectMcp(): Promise<void> {
        await this.mcp("initialize", {
            protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" },
        });
        await this.request({
            subtype: "mcp_message", server_name: "pi", message: { jsonrpc: "2.0", method: "notifications/initialized" },
        });
        const list = await this.mcp("tools/list", {});
        this.listedTools = list.tools as FakeProcess["listedTools"];
    }

    private accept(message: FakeUserMessage): void {
        this.userMessages.push(message);
        const sessionId = this.sessionId;
        if (this.persist && sessionId) this.fake.sessions.add(sessionId);
        if (this.current && !this.current.finished && !this.fake.queueAdditionalInput) {
            this.current.injected.push(message);
            return;
        }
        this.queue.push(message);
        if (!this.draining) void this.drain();
    }

    private async drain(): Promise<void> {
        this.draining = true;
        while (!this.exited && this.queue.length) {
            const turn = new FakeTurn(this, this.queue.shift() as FakeUserMessage);
            this.current = turn;
            this.turns.push(turn);
            await this.mcpReady;
            turn.emitInit();
            try {
                await this.fake.onTurn(turn);
            } catch (error) {
                if (!turn.signal.aborted) turn.failure = error as Error;
            }
            turn.finish();
        }
        this.current = undefined;
        this.draining = false;
    }

    private exit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.exited) return;
        this.exited = true;
        this.exitCode = code;
        this.signalCode = signal;
        this.queue.length = 0;
        this.current?.abort();
        for (const waiter of this.pending.values()) waiter.reject(new Error("Fake Claude Code exited"));
        this.pending.clear();
        setImmediate(() => {
            this.stdout.end();
            this.emit("exit", code, signal);
        });
    }
}

export class FakeTurn {
    readonly injected: FakeUserMessage[] = [];
    finished = false;
    failure: Error | undefined;
    private readonly controller = new AbortController();
    private apiCalls = 0;
    private lastText = "";
    private readonly totals = {
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    };

    constructor(readonly process: FakeProcess, readonly message: FakeUserMessage) {}

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    get content(): Json[] {
        const content = this.message.message.content;
        return typeof content === "string" ? [{ type: "text", text: content }] : content;
    }

    get text(): string {
        return this.content.filter(block => block.type === "text").map(block => block.text as string).join("\n");
    }

    abort(): void {
        this.controller.abort();
    }

    untilAborted(): Promise<void> {
        if (this.signal.aborted) return Promise.resolve();
        return new Promise(resolve => this.signal.addEventListener("abort", () => resolve(), { once: true }));
    }

    emit(message: Json): void {
        const session_id = this.process.sessionId;
        this.process.write({ parent_tool_use_id: null, uuid: randomUUID(), session_id, ...message });
    }

    streamEvent(event: Json): void {
        this.emit({ type: "stream_event", event });
    }

    emitInit(): void {
        const bridged = ((this.process.initialize?.sdkMcpServers as string[] | undefined) ?? []).includes("pi");
        this.emit({
            type: "system", subtype: "init", cwd: this.process.options.cwd ?? "",
            tools: this.process.listedTools.map(tool => TOOL_PREFIX + tool.name),
            mcp_servers: bridged ? [{ name: "pi", status: this.process.fake.bridgeStatus }] : [],
            model: this.process.model ?? "default", permissionMode: "dontAsk", slash_commands: [], skills: [],
            plugins: [], output_style: "default", apiKeySource: "none",
            claude_code_version: this.process.fake.version ?? "",
        });
    }

    async assistant(blocks: FakeBlock[], options: AssistantOptions = {}): Promise<string> {
        const id = options.messageId ?? `msg_${randomUUID()}`;
        const tokens = options.usage ?? { input_tokens: 10, output_tokens: 5 };
        const usage = {
            input_tokens: tokens.input_tokens, output_tokens: tokens.output_tokens,
            cache_read_input_tokens: tokens.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: tokens.cache_creation_input_tokens ?? 0,
        };
        const model = this.process.model ?? "claude-fixture";
        const calls = blocks.some(block => block.type === "tool_use");
        const stopReason = options.stopReason ?? (calls ? "tool_use" : "end_turn");
        const content: Json[] = blocks.map(block => block.type === "tool_use"
            ? { ...block, name: TOOL_PREFIX + block.name }
            : block.type === "thinking" ? { ...block, signature: "fixture-signature" } : { ...block });
        this.apiCalls++;
        for (const key of Object.keys(this.totals) as (keyof typeof this.totals)[]) this.totals[key] += usage[key];
        const text = blocks.filter(block => block.type === "text").map(block => block.text).join("");
        if (text) this.lastText = text;
        const streamed = options.stream !== false;
        if (streamed) {
            this.streamEvent({
                type: "message_start",
                message: {
                    id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
                    usage: { ...usage, output_tokens: 1 },
                },
            });
            content.forEach((block, index) => this.streamBlock(block, index));
        }
        const uuid = randomUUID();
        this.emit({
            type: "assistant", uuid,
            message: {
                id, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null,
                usage,
            },
        });
        this.process.assistantUuids.push(uuid);
        if (streamed) {
            this.streamEvent({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
            this.streamEvent({ type: "message_stop" });
        }
        await new Promise(resolve => setImmediate(resolve));
        return uuid;
    }

    reply(text: string, options: AssistantOptions = {}): Promise<string> {
        return this.assistant(text ? [{ type: "text", text }] : [], options);
    }

    async callTool(name: string, input: Json, id = `toolu_${randomUUID()}`): Promise<CallToolResult> {
        const [result] = await this.callTools([{ name, input, id }]);
        return result;
    }

    async callTools(
        calls: { name: string; input: Json; id?: string }[],
        options: AssistantOptions = {},
    ): Promise<CallToolResult[]> {
        const blocks = calls.map(call => ({
            type: "tool_use" as const, id: call.id ?? `toolu_${randomUUID()}`, name: call.name, input: call.input,
        }));
        await this.assistant(blocks, options);
        const results: CallToolResult[] = [];
        for (const block of blocks) {
            const hooks = this.process.initialize?.hooks as Record<string, { hookCallbackIds: string[] }[]> | undefined;
            const matchers = hooks?.PreToolUse ?? [];
            const input = {
                hook_event_name: "PreToolUse", session_id: this.process.sessionId, transcript_path: "",
                cwd: this.process.options.cwd ?? "", permission_mode: "dontAsk", tool_name: TOOL_PREFIX + block.name,
                tool_input: block.input, tool_use_id: block.id,
            };
            for (const matcher of matchers) {
                for (const callbackId of matcher.hookCallbackIds) {
                    this.process.hookInputs.push(input);
                    await this.abortable(this.process.request({
                        subtype: "hook_callback", callback_id: callbackId, input, tool_use_id: block.id,
                    }));
                }
            }
            const call = this.process.mcp("tools/call", { name: block.name, arguments: block.input });
            const result = await this.abortable(call) as CallToolResult;
            this.process.toolCalls.push({ id: block.id, name: block.name, arguments: block.input, result });
            results.push(result);
        }
        return results;
    }

    finish(overrides: Json = {}): void {
        if (this.finished) return;
        this.finished = true;
        const aborted = this.signal.aborted;
        const failed = aborted || this.failure !== undefined;
        this.process.write({
            type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
            duration_ms: 1, duration_api_ms: 1, num_turns: Math.max(this.apiCalls, 1),
            ...(failed
                ? { errors: [aborted ? "Request was aborted." : (this.failure as Error).message] }
                : { result: this.lastText }),
            stop_reason: failed ? null : "end_turn", total_cost_usd: 0,
            usage: {
                ...this.totals, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
                service_tier: "standard",
            },
            modelUsage: {}, permission_denials: [], session_id: this.process.sessionId, uuid: randomUUID(),
            ...overrides,
        });
    }

    private streamBlock(block: Json, index: number): void {
        const halves = (value: string): string[] => {
            const chars = Array.from(value);
            const middle = Math.ceil(chars.length / 2);
            return [chars.slice(0, middle).join(""), chars.slice(middle).join("")].filter(Boolean);
        };
        const start = (contentBlock: Json): void =>
            this.streamEvent({ type: "content_block_start", index, content_block: contentBlock });
        const delta = (body: Json): void => this.streamEvent({ type: "content_block_delta", index, delta: body });
        if (block.type === "text") {
            start({ type: "text", text: "" });
            for (const text of halves(block.text as string)) delta({ type: "text_delta", text });
        } else if (block.type === "thinking") {
            start({ type: "thinking", thinking: "", signature: "" });
            for (const thinking of halves(block.thinking as string)) delta({ type: "thinking_delta", thinking });
            delta({ type: "signature_delta", signature: "fixture-signature" });
        } else {
            start({ type: "tool_use", id: block.id, name: block.name, input: {} });
            for (const partial_json of halves(JSON.stringify(block.input))) {
                delta({ type: "input_json_delta", partial_json });
            }
        }
        this.streamEvent({ type: "content_block_stop", index });
    }

    private abortable<T>(promise: Promise<T>): Promise<T> {
        if (this.signal.aborted) return Promise.reject(new Error("Fake turn aborted"));
        return new Promise<T>((resolve, reject) => {
            const onAbort = (): void => reject(new Error("Fake turn aborted"));
            this.signal.addEventListener("abort", onAbort, { once: true });
            promise.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", onAbort));
        });
    }
}
