import type {
    Api, AssistantMessage, AssistantMessageEventStream, JsonObject, Model, TextContent, ThinkingContent, ToolCall,
} from "@earendil-works/pi-ai";

/**
 * Builds one Pi assistant message and its event stream. Mutates `output` before each push, emits `start` once, and
 * ends with exactly one terminal event; every call after the first terminal call is a no-op.
 */
export class PiStreamWriter {
    readonly output: AssistantMessage;
    private started = false;
    private ended = false;

    constructor(
        model: Model<Api>,
        private readonly stream: AssistantMessageEventStream,
        providerThinkingLevel: string | undefined,
    ) {
        this.output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            ...(providerThinkingLevel === undefined ? {} : { providerThinkingLevel }),
            usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
    }

    get finished(): boolean {
        return this.ended;
    }

    start(): void {
        if (this.started || this.ended) return;
        this.started = true;
        this.stream.push({ type: "start", partial: this.output });
    }

    textStart(): number {
        return this.open({ type: "text", text: "" }, "text_start");
    }

    textDelta(index: number, delta: string): void {
        if (this.ended) return;
        (this.output.content[index] as TextContent).text += delta;
        this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
    }

    textEnd(index: number): void {
        if (this.ended) return;
        const content = (this.output.content[index] as TextContent).text;
        this.stream.push({ type: "text_end", contentIndex: index, content, partial: this.output });
    }

    thinkingStart(): number {
        return this.open({ type: "thinking", thinking: "" }, "thinking_start");
    }

    thinkingDelta(index: number, delta: string): void {
        if (this.ended) return;
        (this.output.content[index] as ThinkingContent).thinking += delta;
        this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
    }

    thinkingEnd(index: number): void {
        if (this.ended) return;
        const content = (this.output.content[index] as ThinkingContent).thinking;
        this.stream.push({ type: "thinking_end", contentIndex: index, content, partial: this.output });
    }

    toolCallStart(id: string, name: string): number {
        return this.open({ type: "toolCall", id, name, arguments: {} }, "toolcall_start");
    }

    /** Emits argument text; `partial` replaces the block's arguments with the arguments parsed so far. */
    toolCallDelta(index: number, delta: string, partial?: JsonObject): void {
        if (this.ended) return;
        if (partial) (this.output.content[index] as ToolCall).arguments = partial;
        this.stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: this.output });
    }

    toolCallEnd(index: number, args: Pick<ToolCall, "arguments" | "argumentsError">): void {
        if (this.ended) return;
        const toolCall = this.output.content[index] as ToolCall;
        toolCall.arguments = args.arguments;
        if (args.argumentsError !== undefined) toolCall.argumentsError = args.argumentsError;
        this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.output });
    }

    done(reason: "stop" | "length" | "toolUse"): void {
        if (this.ended) return;
        this.start();
        this.ended = true;
        this.output.stopReason = reason;
        this.stream.push({ type: "done", reason, message: this.output });
        this.stream.end();
    }

    fail(reason: "error" | "aborted", message: string): void {
        if (this.ended) return;
        this.ended = true;
        this.output.stopReason = reason;
        this.output.errorMessage = message;
        this.stream.push({ type: "error", reason, error: this.output });
        this.stream.end();
    }

    private open(
        block: AssistantMessage["content"][number],
        type: "text_start" | "thinking_start" | "toolcall_start",
    ): number {
        if (this.ended) return -1;
        this.start();
        const index = this.output.content.push(block) - 1;
        this.stream.push({ type, contentIndex: index, partial: this.output });
        return index;
    }
}
