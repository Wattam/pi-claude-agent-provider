import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { AUTH_STATUS_TIMEOUT_MS, STDERR_TAIL_CHARS } from "./constants.js";
import { loadSdk } from "./sdk.js";

/** Process and filesystem access the adapter needs; tests replace it with a controlled Claude Code fixture. */
export interface ClaudeIO {
    /** Absolute path of `claude` on PATH. */
    which(): string | undefined;
    /** Base environment before isolation. */
    env(): NodeJS.ProcessEnv;
    /** Launches a controllable child and forwards decoded stderr without inheriting Pi's environment. */
    spawn(options: SpawnOptions, onStderr: (text: string) => void): SpawnedProcess;
    authStatus(
        executable: string,
        env: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
    sessionExists(sessionId: string, cwd: string): Promise<boolean>;
}

/**
 * Owns one Claude Code child: Pi launches it, keeps the tail of its stderr for error messages, and can end it
 * immediately. The SDK's own `stderr` option and stderr tail only apply to its internal launcher, so every query Pi
 * starts routes its launch through `launch`.
 */
export class ChildLauncher {
    private child: SpawnedProcess | undefined;
    private text = "";

    constructor(private readonly spawn: ClaudeIO["spawn"]) {}

    readonly launch = (options: SpawnOptions): SpawnedProcess => {
        this.child = this.spawn(options, (chunk) => {
            this.text = (this.text + chunk).slice(-STDERR_TAIL_CHARS);
        });
        return this.child;
    };

    /** The child's last stderr output, or an empty string when it wrote none. */
    get tail(): string {
        return this.text.trim();
    }

    /** Ends a running child at once; a child that already exited or was signalled is left alone. */
    kill(): void {
        if (this.child?.exitCode === null && this.child.signalCode == null) this.child.kill("SIGKILL");
    }
}

// Variables that would route Claude Code away from the subscription login or override Pi-controlled behavior.
const ROUTING_VARIABLES = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_EXTRA_BODY",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "MCP_TOOL_TIMEOUT",
    "AWS_BEARER_TOKEN_BEDROCK",
];

// Claude Code features that duplicate Pi's own; Pi's version wins.
const ISOLATION: Record<string, string> = {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    // Only Pi decides which tools run when it resumes a conversation.
    CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: "1",
    MAX_MCP_OUTPUT_TOKENS: "200000",
};

/** Builds the Claude child environment from `base` without mutating it or `process.env`. */
export function childEnv(base: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(base)) {
        if (typeof value === "string" && !name.startsWith("ANTHROPIC_")) env[name] = value;
    }
    for (const name of ROUTING_VARIABLES) delete env[name];
    return { ...env, ...ISOLATION };
}

function isExecutableFile(path: string): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export const realIO: ClaudeIO = {
    which() {
        for (const dir of (process.env.PATH ?? "").split(delimiter)) {
            if (!dir) continue;
            const candidate = join(dir, "claude");
            if (isExecutableFile(candidate)) return candidate;
        }
        return undefined;
    },
    env() {
        return process.env;
    },
    spawn({ command, args, cwd, env, signal }, onStderr) {
        const child = spawn(command, args, {
            cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", onStderr);
        return child;
    },
    authStatus(executable, env, signal) {
        return new Promise((resolve, reject) => {
            execFile(
                executable,
                ["auth", "status", "--json"],
                { env, timeout: AUTH_STATUS_TIMEOUT_MS, signal, maxBuffer: 1_048_576, encoding: "utf8" },
                (error, stdout, stderr) => {
                    // A numeric code is a normal non-zero exit; anything else is a spawn failure, timeout, or abort.
                    if (error && typeof error.code !== "number") {
                        reject(error);
                        return;
                    }
                    resolve({ stdout, stderr, exitCode: error ? error.code as number : 0 });
                },
            );
        });
    },
    async sessionExists(sessionId, cwd) {
        return (await (await loadSdk()).getSessionInfo(sessionId, { dir: cwd })) !== undefined;
    },
};
