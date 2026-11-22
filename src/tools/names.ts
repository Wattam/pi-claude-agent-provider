import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";
import { TOOL_PREFIX } from "../constants.js";

/** An MCP-safe tool name that fits the SDK's 64-character limit after `TOOL_PREFIX`. */
export function shortName(name: string): string {
    const limit = 64 - TOOL_PREFIX.length;
    if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name;
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 10);
    return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, limit - 11)}_${hash}`;
}

/** The Pi tool name for an SDK tool name; undefined for tools Pi did not offer. */
export function piToolName(sdkName: string, tools: readonly Tool[]): string | undefined {
    return tools.find(tool => TOOL_PREFIX + shortName(tool.name) === sdkName)?.name;
}
