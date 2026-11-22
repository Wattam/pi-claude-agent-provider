/** Narrows an unknown value to a plain object record; arrays and null are excluded. */
export function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The message of a thrown value, for diagnostics that must not depend on what was thrown. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
