// Timestamps from the API are ISO 8601 UTC, e.g. "2026-11-14T18:00:00Z".
export function formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
        return iso;
    }
    return date.toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function formatTime(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
        return iso;
    }
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
