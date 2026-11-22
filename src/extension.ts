import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, STATE_ENTRY_TYPE } from "./constants.js";
import { ExtraUsageGuard } from "./extra-usage.js";
import { realIO, type ClaudeIO } from "./io.js";
import { createClaudeAgentProvider, type ActiveSession } from "./provider.js";
import { SessionRuntime } from "./session-runtime.js";

// The extra-usage guard lives for the Pi process: session replacement and /reload re-run this factory with a fresh
// module, so the guard is kept on globalThis and created only when absent.
const GUARD_KEY = Symbol.for("claude-agent-provider.extra-usage-guard");

type GuardHolder = Record<symbol, unknown>;

/** Registers the Claude Agent provider and ties one session runtime to each Pi session. Starts no process. */
export function registerClaudeAgent(pi: ExtensionAPI, io: ClaudeIO = realIO): void {
    let active: ActiveSession | undefined;

    pi.registerProvider(createClaudeAgentProvider({ io, getActive: () => active }));

    pi.on("session_start", (_event, ctx) => {
        const holder = globalThis as GuardHolder;
        // Check presence only: each factory run loads a new ExtraUsageGuard class, so instanceof would never match.
        holder[GUARD_KEY] ??= new ExtraUsageGuard();
        const guard = holder[GUARD_KEY] as ExtraUsageGuard;
        const piSessionId = ctx.sessionManager.getSessionId();
        active = {
            piSessionId,
            runtime: new SessionRuntime({
                io,
                guard,
                piSessionId,
                cwd: ctx.cwd,
                sessionManager: ctx.sessionManager,
                writeRecord: record => pi.appendEntry(STATE_ENTRY_TYPE, record),
                warn: (message) => {
                    if (ctx.hasUI) ctx.ui.notify(message, "warning");
                    else process.stderr.write(`${message}\n`);
                },
            }),
        };
    });

    pi.on("session_shutdown", async () => {
        const current = active;
        active = undefined;
        await current?.runtime.shutdown();
    });

    pi.on("agent_settled", async () => {
        await active?.runtime.settle();
    });

    pi.on("cache_warming_decision", (_event, ctx) =>
        ctx.model?.provider === PROVIDER_ID ? { action: "stop" } : undefined);
}
