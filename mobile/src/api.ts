import Constants from "expo-constants";
import { getAuth, setAuth } from "@/auth";

// The dev machine's LAN IP comes from the Expo dev server host (see README):
// `expoConfig.hostUri` is "192.168.x.x:8081" while running from Expo Go.
// The API itself runs on port 3000 on the same machine.
const DEV_SERVER_IP = (Constants.expoConfig?.hostUri ?? "localhost").split(":")[0];
const API_URL = `http://${DEV_SERVER_IP}:3000/api`;

// Every API error carries the shape from docs/api.md ("Errors"):
// { error: { code, message } }. `status` is the HTTP status code,
// 0 when the request never reached the server.
export class ApiError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(message: string, code: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}

export type User = {
    id: string;
    email: string;
    name: string;
    role: "attendee" | "organizer" | "event_admin" | "platform_admin";
};

export type EventStatus = "draft" | "published" | "cancelled";

// Same item shape as GET /api/events; this is what GET /api/staff/events returns.
export type EventListItem = {
    id: string;
    title: string;
    description: string;
    venue_name: string;
    venue_address: string;
    starts_at: string;
    ends_at: string;
    status: EventStatus;
    cover_image_url: string | null;
    organizer: {
        id: string;
        name: string;
    };
};

export type TicketStatus = "valid" | "checked_in" | "cancelled" | "refunded";

// A check-in ticket, docs/api.md "Check-in (mobile app)".
export type CheckInTicket = {
    id: string;
    code: string;
    status: TicketStatus;
    attendee_name: string;
    ticket_type_name: string;
    checked_in_at: string | null;
};

export type CheckInResult =
    | "valid"
    | "already_used"
    | "cancelled"
    | "refunded"
    | "invalid"
    | "not_found"
    | "wrong_event";

export type CheckInResponse = {
    result: CheckInResult;
    ticket: CheckInTicket | null;
    checked_in_at: string | null;
};

export type AttendeeCounts = {
    registered: number;
    checked_in: number;
};

export type AttendeesResponse = {
    attendees: CheckInTicket[];
    counts: AttendeeCounts;
    limit: number;
    offset: number;
};

type AuthResponse = {
    user: User;
    token: string;
};

async function request<T>(path: string, options: { method?: string; body?: object } = {}): Promise<T> {
    const url = `${API_URL}${path}`;
    const token = await getAuth();
    const headers: Record<string, string> = {};
    if (token !== null) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: options.method ?? "GET",
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
    } catch {
        throw new ApiError(
            "Cannot reach the server. Check that you are on the same Wi-Fi as the computer running the API.",
            "NETWORK_ERROR",
            0,
        );
    }

    if (!response.ok) {
        let message = `Request failed (HTTP ${response.status})`;
        let code = "UNKNOWN_ERROR";
        try {
            const data = (await response.json()) as { error?: { code?: string; message?: string } };
            if (typeof data?.error?.message === "string") {
                message = data.error.message;
            }
            if (typeof data?.error?.code === "string") {
                code = data.error.code;
            }
        } catch {
            // not JSON, keep the fallback message
        }
        throw new ApiError(message, code, response.status);
    }

    return (await response.json()) as T;
}

    // GET REQUESTS

export async function listStaffEvents(): Promise<EventListItem[]> {
    return (await request<{ events: EventListItem[] }>("/staff/events")).events;
}

export async function listAttendees(eventId: string, q?: string): Promise<AttendeesResponse> {
    const params = new URLSearchParams({ limit: "100", offset: "0" });
    if (q !== undefined && q.trim() !== "") {
        params.set("q", q.trim());
    }
    return request<AttendeesResponse>(
        `/staff/events/${encodeURIComponent(eventId)}/attendees?${params.toString()}`,
    );
}

export async function getUser(): Promise<User> {
    return (await request<{ user: User }>("/auth/me")).user;
}

    // POST REQUESTS

export async function loginUser(email: string, password: string): Promise<User> {
    const response = await request<AuthResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
    });
    await setAuth(response.token);
    return response.user;
}

export async function checkIn(eventId: string, qrPayload: string): Promise<CheckInResponse> {
    return request<CheckInResponse>("/staff/check-in", {
        method: "POST",
        body: { event_id: eventId, qr_payload: qrPayload },
    });
}

export async function undoCheckIn(ticketId: string): Promise<CheckInTicket> {
    return (
        await request<{ ticket: CheckInTicket }>(
            `/staff/check-in/${encodeURIComponent(ticketId)}/undo`,
            { method: "POST" },
        )
    ).ticket;
}
