import { createHash } from "node:crypto";
import type { ClaudeIO } from "./io.js";
import { NOT_LOGGED_IN, authStatusFailed, truncateReason, unsupportedRoute } from "./messages.js";
import { errorMessage, isObject } from "./values.js";

export interface LoginIdentity {
    /** SHA-256 digest of the login email and organization id; the only identity the adapter keeps. */
    accountKey: string;
}

interface AuthStatus {
    loggedIn?: unknown;
    apiProvider?: unknown;
    authMethod?: unknown;
    email?: unknown;
    orgId?: unknown;
}

function parseStatus(stdout: string): AuthStatus | undefined {
    try {
        const value: unknown = JSON.parse(stdout);
        return isObject(value) ? value as AuthStatus : undefined;
    } catch {
        return undefined;
    }
}

/** Reads `claude auth status --json` and accepts only a first-party claude.ai subscription login. */
export async function readLoginIdentity(
    io: ClaudeIO,
    executable: string,
    env: Record<string, string>,
    signal?: AbortSignal,
): Promise<LoginIdentity> {
    let output: Awaited<ReturnType<ClaudeIO["authStatus"]>>;
    try {
        output = await io.authStatus(executable, env, signal);
    } catch (error) {
        throw new Error(authStatusFailed(truncateReason(errorMessage(error))));
    }
    const status = parseStatus(output.stdout);
    if (!status) {
        const firstLine = output.stderr.split("\n")[0];
        throw new Error(authStatusFailed(truncateReason(firstLine || `exit code ${output.exitCode}`)));
    }
    if (status.loggedIn !== true) throw new Error(NOT_LOGGED_IN);
    if (status.apiProvider !== "firstParty") throw new Error(unsupportedRoute(String(status.apiProvider ?? "unknown")));
    if (status.authMethod !== "claude.ai") throw new Error(unsupportedRoute(String(status.authMethod ?? "unknown")));
    const accountKey = createHash("sha256").update(`${status.email ?? ""}\n${status.orgId ?? ""}`).digest("hex");
    return { accountKey };
}
