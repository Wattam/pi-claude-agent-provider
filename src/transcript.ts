import { createHash } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
    AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage,
} from "@earendil-works/pi-ai";
import { unsupportedImage } from "./messages.js";

export type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];
export type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const CHECKPOINT_OPEN = "<conversation-checkpoint>\nThe following is conversation history from Pi that you have not "
    + "seen. Treat it as prior conversation, not a new request. Continue with the user messages after this checkpoint.";
const CHECKPOINT_CLOSE = "</conversation-checkpoint>";

/** Messages the native session can represent: no system messages and no failed or aborted replies. */
export function conversationMessages(messages: readonly Message[]): ConversationMessage[] {
    return messages.filter((message): message is ConversationMessage => {
        if (message.role === "system") return false;
        return message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted");
    });
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** JSON with recursively sorted keys and without undefined fields. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const object = value as Record<string, unknown>;
        const fields: string[] = [];
        for (const key of Object.keys(object).sort()) {
            if (object[key] !== undefined) fields.push(`${JSON.stringify(key)}:${canonical(object[key])}`);
        }
        return `{${fields.join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function normalized(content: string | readonly (TextContent | ImageContent)[]): unknown[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return content.map(block => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "image", mimeType: block.mimeType, data: sha256(block.data) });
}

/** Stable identity of a message: content digests for user input and tool results, provider stamps for replies. */
export function messageKey(message: ConversationMessage): string {
    switch (message.role) {
        case "user":
            return sha256(canonical({ r: "user", c: normalized(message.content) }));
        case "toolResult":
            return sha256(canonical({
                r: "toolResult", id: message.toolCallId, e: message.isError, c: normalized(message.content),
            }));
        case "assistant":
            return `a:${message.provider}:${message.timestamp}:${message.responseId ?? ""}`;
    }
}

/** Chained digest of the first `count` messages; "" for an empty prefix. */
export function prefixHash(messages: readonly ConversationMessage[], count: number): string {
    let hash = "";
    for (let index = 0; index < count; index++) hash = sha256(`${hash}\n${messageKey(messages[index])}`);
    return hash;
}

function imageBlock(image: ImageContent): ContentBlock {
    if (!IMAGE_TYPES.includes(image.mimeType)) throw new Error(unsupportedImage(image.mimeType));
    return {
        type: "image",
        source: { type: "base64", media_type: image.mimeType as ImageMediaType, data: image.data },
    };
}

function text(value: string): ContentBlock {
    return { type: "text", text: value };
}

function userBlocks(message: UserMessage): ContentBlock[] {
    if (typeof message.content === "string") return [text(message.content)];
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
        if (block.type === "image") blocks.push(imageBlock(block));
        else if (block.text) blocks.push(text(block.text));
    }
    return blocks;
}

/** User messages as Claude content blocks. */
export function renderPlain(messages: readonly UserMessage[]): ContentBlock[] {
    return messages.flatMap(userBlocks);
}

function assistantBlocks(message: AssistantMessage): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            if (block.text) blocks.push(text(block.text));
        } else if (block.type === "toolCall") {
            const call = JSON.stringify({ id: block.id, name: block.name, input: block.arguments });
            blocks.push(text(`<tool-call>\n${call}\n</tool-call>`));
        }
    }
    return blocks;
}

function toolResultBlocks(message: ToolResultMessage): ContentBlock[] {
    const output = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const result = JSON.stringify({ id: message.toolCallId, name: message.toolName, isError: message.isError, output });
    const images = message.content.filter((block): block is ImageContent => block.type === "image").map(imageBlock);
    return [text(`<tool-result>\n${result}\n</tool-result>`), ...images];
}

const TAGS = { user: "user", assistant: "assistant", toolResult: "tool" } as const;

function historyBlocks(message: ConversationMessage): ContentBlock[] {
    const tag = TAGS[message.role];
    const body = message.role === "user" ? userBlocks(message)
        : message.role === "assistant" ? assistantBlocks(message) : toolResultBlocks(message);
    return [text(`<${tag}>`), ...body, text(`</${tag}>`)];
}

/**
 * Input for a new native turn. History the native session has not seen is wrapped in one checkpoint, because
 * Claude cannot be given earlier turns; the trailing user messages follow as plain input.
 */
export function renderInput(unseen: readonly ConversationMessage[]): ContentBlock[] {
    const end = unseen.findLastIndex(message => message.role !== "user") + 1;
    const blocks: ContentBlock[] = [];
    if (end > 0) {
        blocks.push(text(CHECKPOINT_OPEN), ...unseen.slice(0, end).flatMap(historyBlocks), text(CHECKPOINT_CLOSE));
    }
    blocks.push(...renderPlain(unseen.slice(end) as UserMessage[]));
    return blocks;
}
