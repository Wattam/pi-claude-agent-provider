import { INTERRUPT_TIMEOUT_MS, MIN_CLAUDE_CODE_VERSION, REASON_MAX_CHARS } from "./constants.js";

export const NOT_INSTALLED = "Claude Code is not installed or `claude` is not on PATH. Install Claude Code, run "
    + "`claude auth login` in a terminal, then retry.";
export const SDK_MISSING = "Claude Agent SDK could not load. Reinstall pi-claude-agent-provider, "
    + "or run `npm install` in the source checkout, then run /reload.";
export const NOT_LOGGED_IN = "Claude Code is not logged in. Run `claude auth login` in a terminal, then retry.";
export const STARTUP_TIMEOUT = "Claude Code did not start within 30 seconds. Check that `claude` runs in a terminal, "
    + "then retry.";
export const BRIDGE_FAILED = "The Pi tool bridge did not connect to Claude Code; the request was stopped without "
    + "fallback tools.";
export const STANDALONE = "Claude Agent only serves the active Pi chat. Standalone model calls (session naming, "
    + "summaries, compaction, cache warming) are not supported.";
export const HANDOFF = "This chat has history from another provider. Claude Agent cannot take over an existing "
    + "conversation; start a new session with /new and select a Claude Agent model.";
export const HISTORY_CHANGED = "This chat's history no longer matches its Claude Agent session (edited history, "
    + "provider switch, or /tree navigation). Start a new session with /new to continue with Claude Agent.";
export const FORKED = "This chat was forked or cloned from another session. Claude Agent cannot continue a forked "
    + "chat; start a new session with /new.";
export const ACCOUNT_CHANGED = "This chat's Claude Agent state belongs to a different Claude login. Run "
    + "`claude auth login` with the original account, or start a new session with /new.";
export const INVALID_STATE = "This chat's Claude Agent state is unreadable. Start a new session with /new.";
export const TRANSCRIPT_MISSING = "The Claude Code transcript for this chat is missing, so Claude Agent cannot resume "
    + "it without losing history. Start a new session with /new.";
export const TRANSCRIPT_LOST = "Claude Code could not save part of this chat's transcript (the disk is full or the "
    + "quota is used up), so Claude Agent cannot resume it without losing history. Free disk space, then start a new "
    + "session with /new.";
export const NO_NEW_INPUT = "Claude Agent requires new user input or tool results; context-only continuation "
    + "requests are not supported.";
export const INVALID_PAYLOAD = "A before_provider_request handler returned a payload Claude Agent cannot send.";
export const ABORTED = "Request was aborted";
export const INTERRUPT_TIMEOUT = "Claude Code did not finish the interrupted turn within "
    + `${INTERRUPT_TIMEOUT_MS / 1000} seconds`;
export const AUTH_EXPIRED = "Claude Code authentication failed or expired. Run `claude auth login` in a terminal, "
    + "then retry.";

export function authStatusFailed(reason: string): string {
    return `Claude Code login status could not be read (${reason}). Run \`claude auth login\` in a terminal, `
        + "then retry.";
}

export function unsupportedRoute(route: string): string {
    return "Claude Agent requires the Claude subscription login from `claude auth login`. The active Claude Code "
        + `route is ${route}; API keys, cloud providers, gateways, and custom endpoints are not used. Run `
        + "`claude auth login` with your Claude account, then retry.";
}

export function tooOld(version: string | undefined): string {
    return `Claude Code ${version ?? "(unknown version)"} is not supported; Claude Agent requires `
        + `${MIN_CLAUDE_CODE_VERSION} or later. Run \`claude update\`, then retry.`;
}

export function unsupportedImage(mime: string): string {
    return `Claude Agent does not support ${mime} images.`;
}

function resetTime(resetsAt: number): string {
    return new Date(resetsAt * 1000).toISOString();
}

function blockedUntil(resetsAt?: number): string {
    return resetsAt === undefined
        ? "Requests for this Claude account are blocked until Pi restarts."
        : `Requests for this Claude account are blocked until the quota resets at ${resetTime(resetsAt)}.`;
}

export function quotaExceeded(window?: string, resetsAt?: number): string {
    return `Claude subscription usage quota exceeded${window ? ` (${window} limit)` : ""}.`
        + `${resetsAt ? ` Resets at ${resetTime(resetsAt)}.` : ""}`
        + " Claude Agent does not fall back to paid credits or API billing.";
}

export function extraUsageStopped(resetsAt?: number): string {
    return "Claude Agent stopped this chat: Claude reported that this request uses extra usage credits because the "
        + `subscription quota is used up. Claude Agent never relies on paid billing. ${blockedUntil(resetsAt)}`;
}

export function extraUsageWarning(): string {
    return "Claude Agent: a request drew on extra usage credits before it could be stopped and may be billed. "
        + "Disable extra usage for this Claude account or organization to prevent any paid usage.";
}

export function extraUsageBlocked(resetsAt?: number): string {
    return "Claude Agent blocked this request: the subscription quota is used up and Claude would bill it as extra "
        + `usage credits. ${blockedUntil(resetsAt)}`;
}

export function billingError(text: string): string {
    return `${text} Check your Claude plan; Claude Agent does not use paid credits or API billing.`;
}

export function serverError(status: number): string {
    const head = status === 529 ? "Anthropic is overloaded (529)." : `Anthropic returned HTTP ${status}.`;
    return `${head} Claude Code exhausted its retries. Try again shortly.`;
}

export function stopped(stderrTail?: string): string {
    return withLastOutput("Claude Code stopped before finishing its reply.", stderrTail);
}

/** Appends the Claude Code child's last stderr output to a failure message. */
export function withLastOutput(message: string, stderrTail?: string): string {
    return `${message}${stderrTail ? ` Last output: ${stderrTail}` : ""}`;
}

export function incomplete(status?: number): string {
    return `Claude Code could not finish its reply${status ? ` (HTTP ${status})` : ""}.`;
}

/** Collapses whitespace to single spaces and cuts the text to `REASON_MAX_CHARS` with a trailing ellipsis. */
export function truncateReason(text: string): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length <= REASON_MAX_CHARS ? collapsed : `${collapsed.slice(0, REASON_MAX_CHARS - 1)}…`;
}
