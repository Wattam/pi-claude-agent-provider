import type {
    SDKAssistantMessage, SDKAssistantMessageError, SDKMessage, SDKPartialAssistantMessage, SDKRateLimitInfo,
    SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ToolCallArgumentsStream, type Api, type Model, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { AUTH_EXPIRED, billingError, incomplete, quotaExceeded, serverError } from "./messages.js";
import type { PiStreamWriter } from "./stream-writer.js";
import { piToolName } from "./tools/names.js";
import { UsageTracker } from "./usage.js";

type OpenBlock =
    | { kind: "text"; index: number }
    | { kind: "thinking"; index: number }
    | { kind: "tool"; index: number; args: ToolCallArgumentsStream };

type StreamEvent = SDKPartialAssistantMessage["event"];
type StartedBlock = Extract<StreamEvent, { type: "content_block_start" }>["content_block"];
type BlockDelta = Extract<StreamEvent, { type: "content_block_delta" }>["delta"];

const LOGIN_HINT = "Please run /login";
const PI_LOGIN_HINT = "Run `claude auth login` in a terminal";

/**
 * Turns the top-level SDK messages of one Pi request into Pi stream events, deduplicated usage, and diagnostics.
 * Subagent messages (non-null `parent_tool_use_id`) never change the Pi output.
 */
export class ClaudeStreamConverter {
    private readonly usage = new UsageTracker();
    private readonly streamed = new Set<string>();
    private readonly blocks = new Map<number, OpenBlock>();
    private apiMessageId: string | undefined;
    private errorCode: SDKAssistantMessageError | undefined;
    private rejected: SDKRateLimitInfo | undefined;
    private toolCallIds: string[] = [];
    private assistantUuid: string | undefined;

    constructor(
        private readonly writer: PiStreamWriter,
        private readonly tools: readonly Tool[],
        private readonly model: Model<Api>,
    ) {}

    /** Pi tool_use ids of the last top-level API message. */
    get piToolCallIds(): string[] {
        return this.toolCallIds;
    }

    get lastAssistantUuid(): string | undefined {
        return this.assistantUuid;
    }

    accept(message: SDKMessage): void {
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        if (parent !== null && parent !== undefined) return;
        switch (message.type) {
            case "stream_event":
                this.streamEvent(message.event);
                break;
            case "assistant":
                this.assistant(message);
                break;
            case "rate_limit_event":
                this.rejected = message.rate_limit_info.status === "rejected" ? message.rate_limit_info : undefined;
                break;
            case "result":
                if (message.num_turns === 1) this.usage.result(message.usage);
                break;
        }
    }

    /** The Pi error text for a failed result; undefined for a success. */
    failure(result: SDKResultMessage): string | undefined {
        const status = result.subtype === "success" ? result.api_error_status ?? undefined : undefined;
        if (result.subtype === "success" && !result.is_error && !(status !== undefined && status >= 400)) {
            return undefined;
        }
        const raw = result.subtype === "success" ? result.result ?? "" : result.errors.join("\n");
        const text = raw.replaceAll(LOGIN_HINT, PI_LOGIN_HINT);
        if (this.errorCode === "authentication_failed") return AUTH_EXPIRED;
        if (this.errorCode === "rate_limit" || (this.rejected && status === 429)) {
            return quotaExceeded(this.rejected?.rateLimitType?.replaceAll("_", " "), this.rejected?.resetsAt);
        }
        if (this.errorCode === "billing_error") return billingError(text || "Claude reported a billing error.");
        if (status !== undefined && status >= 500) return serverError(status);
        // Prompt-too-long text passes through unchanged so Pi's overflow detection applies.
        if (text) return text;
        return incomplete(status);
    }

    finishUsage(): void {
        this.usage.apply(this.model, this.writer.output.usage);
    }

    private streamEvent(event: StreamEvent): void {
        switch (event.type) {
            case "message_start":
                this.apiMessageId = event.message.id;
                this.streamed.add(event.message.id);
                this.writer.output.responseModel = event.message.model;
                this.usage.update(event.message.id, event.message.usage);
                this.toolCallIds = [];
                this.blocks.clear();
                break;
            case "content_block_start":
                this.blockStart(event.index, event.content_block);
                break;
            case "content_block_delta":
                this.blockDelta(event.index, event.delta);
                break;
            case "content_block_stop":
                this.blockStop(event.index);
                break;
            case "message_delta":
                if (this.apiMessageId) this.usage.update(this.apiMessageId, event.usage);
                break;
        }
    }

    private blockStart(position: number, block: StartedBlock): void {
        if (block.type === "text") {
            const index = this.writer.textStart();
            this.blocks.set(position, { kind: "text", index });
            if (block.text) this.writer.textDelta(index, block.text);
        } else if (block.type === "thinking") {
            const index = this.writer.thinkingStart();
            this.blocks.set(position, { kind: "thinking", index });
            if (block.thinking) this.writer.thinkingDelta(index, block.thinking);
        } else if (block.type === "tool_use") {
            const name = piToolName(block.name, this.tools);
            if (name === undefined) return;
            const index = this.writer.toolCallStart(block.id, name);
            this.blocks.set(position, { kind: "tool", index, args: new ToolCallArgumentsStream() });
            this.toolCallIds.push(block.id);
        }
    }

    private blockDelta(position: number, delta: BlockDelta): void {
        const block = this.blocks.get(position);
        if (!block) return;
        if (delta.type === "text_delta" && block.kind === "text") {
            this.writer.textDelta(block.index, delta.text);
        } else if (delta.type === "thinking_delta" && block.kind === "thinking") {
            this.writer.thinkingDelta(block.index, delta.thinking);
        } else if (delta.type === "input_json_delta" && block.kind === "tool") {
            this.writer.toolCallDelta(block.index, delta.partial_json, block.args.append(delta.partial_json));
        }
    }

    private blockStop(position: number): void {
        const block = this.blocks.get(position);
        if (!block) return;
        this.blocks.delete(position);
        if (block.kind === "text") this.writer.textEnd(block.index);
        else if (block.kind === "thinking") this.writer.thinkingEnd(block.index);
        else this.writer.toolCallEnd(block.index, block.args.finish());
    }

    private assistant(message: SDKAssistantMessage): void {
        if (message.error) {
            this.errorCode = message.error;
            return;
        }
        this.assistantUuid = message.uuid;
        this.writer.output.responseId = message.uuid;
        const apiMessage = message.message;
        this.usage.update(apiMessage.id, apiMessage.usage);
        if (this.streamed.has(apiMessage.id)) return;
        // Claude Code sent this reply without stream events; build its content once from the complete message.
        this.streamed.add(apiMessage.id);
        this.toolCallIds = [];
        for (const block of apiMessage.content) {
            if (block.type === "text") {
                if (!block.text) continue;
                const index = this.writer.textStart();
                this.writer.textDelta(index, block.text);
                this.writer.textEnd(index);
            } else if (block.type === "thinking") {
                if (!block.thinking) continue;
                const index = this.writer.thinkingStart();
                this.writer.thinkingDelta(index, block.thinking);
                this.writer.thinkingEnd(index);
            } else if (block.type === "tool_use") {
                const name = piToolName(block.name, this.tools);
                if (name === undefined) continue;
                const index = this.writer.toolCallStart(block.id, name);
                this.writer.toolCallEnd(index, { arguments: block.input as ToolCall["arguments"] });
                this.toolCallIds.push(block.id);
            }
        }
    }
}
