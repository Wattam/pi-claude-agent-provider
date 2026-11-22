import type { Query, SDKControlInitializeResponse, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { deadline, deferred } from "./async.js";
import { STARTUP_TIMEOUT_MS } from "./constants.js";
import { ChildLauncher, type ClaudeIO } from "./io.js";
import { STARTUP_TIMEOUT, withLastOutput } from "./messages.js";
import { baseOptions } from "./query-options.js";
import { loadSdk } from "./sdk.js";

export interface Probe {
    query: Query;
    init: SDKControlInitializeResponse;
    close(): void;
}

/** Starts Claude Code without a transcript and waits for its initialization; the input never sends a message. */
export async function openProbe(
    io: ClaudeIO,
    executable: string,
    env: Record<string, string>,
    signal?: AbortSignal,
): Promise<Probe> {
    const { query } = await loadSdk();
    const launcher = new ChildLauncher(io.spawn);
    const stop = deferred<void>();
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        await stop.promise;
    })();
    const session = query({
        prompt,
        options: { ...baseOptions(executable, env, launcher.launch), persistSession: false },
    });
    const close = (): void => {
        stop.resolve();
        session.close();
    };
    try {
        const init = await deadline(session.initializationResult(), STARTUP_TIMEOUT_MS, () => {
            throw new Error(STARTUP_TIMEOUT);
        }, signal);
        return { query: session, init, close };
    } catch (error) {
        close();
        throw explain(error, launcher.tail);
    }
}

/** Keeps Claude Code's last output in the failure, which the SDK reports only for launches it owns. */
function explain(error: unknown, stderrTail: string): unknown {
    if (!stderrTail || !(error instanceof Error)) return error;
    return new Error(withLastOutput(error.message, stderrTail), { cause: error });
}

/** Runs `use` with an open probe and always closes it. */
export async function withProbe<T>(
    io: ClaudeIO,
    executable: string,
    env: Record<string, string>,
    signal: AbortSignal | undefined,
    use: (probe: Probe) => Promise<T>,
): Promise<T> {
    const probe = await openProbe(io, executable, env, signal);
    try {
        return await use(probe);
    } finally {
        probe.close();
    }
}
