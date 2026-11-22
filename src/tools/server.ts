import type { HookCallback, McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { toToolDeclaration, type Tool } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_PREFIX, TOOL_SERVER_NAME } from "../constants.js";
import { piToolName, shortName } from "./names.js";
import type { PendingTools } from "./pending.js";

/** In-process MCP server offering exactly Pi's current tools; each call waits for Pi's own execution result. */
export function createToolServer(tools: readonly Tool[], pending: PendingTools): McpSdkServerConfigWithInstance {
    const server = new Server({ name: TOOL_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
    const definitions = tools.map((tool): McpTool => ({
        name: shortName(tool.name),
        description: tool.description,
        inputSchema: toToolDeclaration(tool).parameters as McpTool["inputSchema"],
        // Claude Code serializes non-read-only tools, so each handler takes its id from the preceding hook.
        annotations: { readOnlyHint: false },
        _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
    }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const sdkName = TOOL_PREFIX + request.params.name;
        if (piToolName(sdkName, tools) === undefined) {
            throw new Error(`Claude Code called an unregistered Pi tool: ${sdkName}`);
        }
        return pending.call(sdkName);
    });
    // The Agent SDK's public instance type names its higher-level McpServer; the low-level Server speaks the same
    // protocol.
    const instance = server as unknown as McpSdkServerConfigWithInstance["instance"];
    return { type: "sdk", name: TOOL_SERVER_NAME, instance };
}

/** PreToolUse hook that announces each tool-use id before Claude Code invokes the MCP handler. */
export function createToolHooks(pending: PendingTools): Options["hooks"] {
    const before: HookCallback = async (input) => {
        if (input.hook_event_name === "PreToolUse") pending.before(input.tool_use_id, input.tool_name);
        return {};
    };
    // Without the id this hook announces, the MCP handler cannot tell which call it serves, so a failed callback
    // must block the call instead of letting Claude Code run it uncorrelated (Claude Code 2.1.317).
    return { PreToolUse: [{ hooks: [before], onFailure: "block" }] };
}
