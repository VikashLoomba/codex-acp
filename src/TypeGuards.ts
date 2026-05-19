export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNotFoundError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT";
}

export function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
