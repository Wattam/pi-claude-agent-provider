import type { EffortLevel, McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { TOOL_PREFIX, TOOL_SERVER_NAME } from "./constants.js";

/** Options shared by probes and chat sessions: no Claude Code settings, skills, built-in tools, or external MCP. */
export function baseOptions(
    executable: string,
    env: Record<string, string>,
    launch: NonNullable<Options["spawnClaudeCodeProcess"]>,
): Options {
    return {
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: launch,
        env,
        settingSources: [],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        skills: [],
        tools: [],
        permissionMode: "dontAsk",
        allowedTools: [`${TOOL_PREFIX}*`],
        verbatimPrompts: true,
    };
}

/** Options for one persisted chat session started fresh or resumed at `start`. */
export function sessionOptions(input: {
    base: Options;
    cwd: string;
    model: string;
    effort: EffortLevel | undefined;
    thinking: "adaptive" | "disabled";
    systemPrompt: string;
    hooks: Options["hooks"];
    toolServer: McpSdkServerConfigWithInstance | undefined;
    start: { sessionId: string } | { resume: string; resumeSessionAt?: string };
}): Options {
    return {
        ...input.base,
        cwd: input.cwd,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        thinking: input.thinking === "adaptive" ? { type: "adaptive", display: "summarized" } : { type: "disabled" },
        systemPrompt: { type: "custom", prompt: input.systemPrompt, snapshot: false },
        includePartialMessages: true,
        persistSession: true,
        hooks: input.hooks,
        mcpServers: input.toolServer ? { [TOOL_SERVER_NAME]: input.toolServer } : {},
        ...input.start,
    };
}
