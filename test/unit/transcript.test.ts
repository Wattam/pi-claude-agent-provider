import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage, Usage } from "@earendil-works/pi-ai";
import { unsupportedImage } from "../../src/messages.js";
import { conversationMessages, messageKey, prefixHash, renderInput, renderPlain } from "../../src/transcript.js";

const ZERO: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const PNG = "iVBORw0KGgo=";

const user = (content: UserMessage["content"], timestamp = 1): UserMessage => ({ role: "user", content, timestamp });
const assistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
    role: "assistant", api: "claude-agent-sdk", provider: "claude-agent", model: "sonnet", usage: ZERO,
    stopReason: "stop", timestamp: 2, responseId: "uuid-1", content: [{ type: "text", text: "Answer" }], ...overrides,
});
const toolResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
    role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "body" }],
    isError: false, timestamp: 3, ...overrides,
} as ToolResultMessage);

type Block = { type: string; text?: string; source?: unknown };
const joined = (blocks: Block[]): string => blocks.map(block => block.text ?? `[${block.type}]`).join("\n");

test("conversation excludes system messages and failed or aborted assistant replies", () => {
    const kept = [user("hi"), assistant(), toolResult()];
    const messages: Message[] = [
        { role: "system", content: "prompt", timestamp: 0 }, kept[0],
        assistant({ stopReason: "error", errorMessage: "boom" }), assistant({ stopReason: "aborted" }), kept[1],
            kept[2],
    ];
    assert.deepEqual(conversationMessages(messages), kept);
});

test("message keys are stable for equivalent user content and depend on image bytes", () => {
    assert.equal(messageKey(user("hello", 1)), messageKey(user([{ type: "text", text: "hello" }], 99)));
    const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
    const reordered = { mimeType: "image/png", data: PNG, type: "image" as const };
    assert.equal(messageKey(user([image])), messageKey(user([reordered])));
    assert.notEqual(messageKey(user([image])), messageKey(user([{ ...image, data: "AAAA" }])));
});

test("tool result keys depend on id, error flag, and content", () => {
    const base = messageKey(toolResult());
    assert.equal(messageKey(toolResult({ timestamp: 50 })), base);
    assert.notEqual(messageKey(toolResult({ toolCallId: "toolu_2" })), base);
    assert.notEqual(messageKey(toolResult({ isError: true })), base);
    assert.notEqual(messageKey(toolResult({ content: [{ type: "text", text: "other" }] })), base);
});

test("assistant keys identify provider, timestamp, and response id", () => {
    assert.equal(messageKey(assistant()), "a:claude-agent:2:uuid-1");
    assert.equal(messageKey(assistant({ responseId: undefined, provider: "openai", timestamp: 7 })), "a:openai:7:");
});

test("prefix hashes cover exactly the counted prefix", () => {
    const messages = [user("one"), assistant(), user("two")];
    assert.equal(prefixHash(messages, 0), "");
    const two = prefixHash(messages, 2);
    assert.match(two, /^[0-9a-f]{64}$/);
    assert.equal(prefixHash([...messages.slice(0, 2), user("changed later")], 2), two);
    assert.notEqual(prefixHash([user("changed"), ...messages.slice(1)], 2), two);
    assert.notEqual(prefixHash(messages, 3), two);
    assert.notEqual(prefixHash([messages[1], messages[0]], 2), two);
});

test("plain rendering keeps text and supported images and skips empty text", () => {
    assert.deepEqual(renderPlain([user("hello"), user([
        { type: "text", text: "" }, { type: "text", text: "see 🖼️" },
        { type: "image", data: PNG, mimeType: "image/png" },
    ])]), [
        { type: "text", text: "hello" },
        { type: "text", text: "see 🖼️" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    for (const mimeType of ["image/jpeg", "image/gif", "image/webp"]) {
        assert.equal(renderPlain([user([{ type: "image", data: PNG, mimeType }])]).length, 1);
    }
});

test("plain rendering rejects unsupported image types", () => {
    assert.throws(() => renderPlain([user([{ type: "image", data: PNG, mimeType: "image/bmp" }])]),
        { message: unsupportedImage("image/bmp") });
});

test("new user-only input is sent without a history checkpoint", () => {
    const unseen = [user("first"), user("second")];
    assert.deepEqual(renderInput(unseen), renderPlain(unseen));
});

test("unseen history is wrapped in one checkpoint before the trailing user input", () => {
    const unseen = [
        user("earlier question"),
        assistant({ content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "Let me read it." },
            { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
        ] }),
        toolResult({ content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] }),
        user("follow-up"),
    ];
    const blocks = renderInput(unseen) as Block[];
    const text = joined(blocks);
    assert.match(blocks[0].text ?? "", /^<conversation-checkpoint>\nThe following is conversation history from Pi/);
    assert.equal(blocks.at(-1)?.text, "follow-up");
    assert.equal(blocks.at(-2)?.text, "</conversation-checkpoint>");
    const callPayload = { id: "toolu_1", name: "read", input: { path: "a.txt" } };
    const resultPayload = { id: "toolu_1", name: "read", isError: false, output: "line 1\nline 2" };
    const order = [
        "<user>", "earlier question", "<assistant>", "Let me read it.",
        `<tool-call>\n${JSON.stringify(callPayload)}\n</tool-call>`, "<tool>",
        `<tool-result>\n${JSON.stringify(resultPayload)}\n</tool-result>`, "</conversation-checkpoint>", "follow-up",
    ];
    let cursor = 0;
    for (const part of order) {
        const index = text.indexOf(part, cursor);
        assert.ok(index >= cursor, `expected ${JSON.stringify(part)} in order`);
        cursor = index + part.length;
    }
    assert.doesNotMatch(text, /private reasoning/);
});

test("tool result images in unseen history are forwarded as image blocks", () => {
    const blocks = renderInput([
        assistant({ content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: {} }] }),
        toolResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] }),
        user("describe it"),
    ]) as Block[];
    assert.deepEqual(blocks.filter(block => block.type === "image"),
        [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]);
});
