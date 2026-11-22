import { MIN_CLAUDE_CODE_VERSION } from "./constants.js";
import { tooOld } from "./messages.js";

/** Compares dot-separated release numbers; a pre-release or build suffix is ignored. */
export function atLeast(version: string, minimum: string): boolean {
    const parse = (value: string): number[] => value.split(/[-+]/)[0].split(".").map(Number);
    const current = parse(version);
    const required = parse(minimum);
    const index = required.findIndex((part, position) => (current[position] ?? 0) !== part);
    return index === -1 || (current[index] ?? 0) > required[index];
}

export function versionError(version: string | undefined): string | undefined {
    return version && atLeast(version, MIN_CLAUDE_CODE_VERSION) ? undefined : tooOld(version);
}

/**
 * The SDK refuses a session whose Claude Code ignores `onFailure` on hook matchers before it reports a version, so
 * that refusal is reported as the version requirement it really is.
 */
export function startupError(message: string): string {
    return /onFailure/.test(message) ? tooOld(undefined) : message;
}
