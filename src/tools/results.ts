import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Pi's tool result as the MCP result Claude Code receives. */
export function toCallToolResult(message: ToolResultMessage): CallToolResult {
    return {
        isError: message.isError,
        content: message.content.map(block => block.type === "text"
            ? { type: "text" as const, text: block.text }
            : { type: "image" as const, data: block.data, mimeType: block.mimeType }),
    };
}
