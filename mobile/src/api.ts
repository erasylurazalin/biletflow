import Constants from "expo-constants";
import { getAuth, setAuth } from "@/auth";

const DEV_SERVER_IP = Constants.manifest2.extra.expoClient.hostUri.split(":")[0]; // <- gets dev server's LOCAL ip
const API_URL = `http://${DEV_SERVER_IP}:3000/api`;

export type User = {
    id : string;
    email : string;
    name : string;
    role : "attendee" | "organizer" | "event_admin" | "platform_admin";
};

export type EventListItem = {
    id: string;
    title: string;
    description: string;
    venue_name: string;
    venue_address: string;
    starts_at: string;
    ends_at: string;
    status: "draft" | "published" | "cancelled" ;
    cover_image_url: string;
    organizer: { 
        id: string; 
        name: string;
    };
};

export type EventDetail = EventListItem & {
    ticket_types: TicketType[];
}

type EventListResponse = {
    events : EventListItem[];
    limit : number;
    offset : number;
}

type TicketType = {
    id : string;
    name : string;
    price : number;
    currency : string;
    quantity_total : number;
    quantity_available : number;
    sales_start_at : string | null;
    sales_end_at : string | null;
    is_hidden : boolean;
};

type OrderItem = {
    ticket_type_id : string;
    name : string;
    quantity : number;
    unit_price : number;
};

export type OrderRequest = {
    ticket_type_id: string;
    quantity: number;
};

export type Order = {
    id : string;
    status : "pending" | "paid" | "cancelled" | "refunded";
    event : {
        id : string;
        title: string;
    }; 
    items : OrderItem[];
    subtotal : number;
    discount : number;
    total : number;
    created_at : string | null;
    expires_at : string | null;
    tickets : Ticket[] | null;
};

export type Ticket = {
    id : string;
    code : string;
    status : "valid" | "checked_in" | "cancelled" | "refunded";
    attendee_name : string;
    ticket_type_name : string;
    event : {
        id : string;
        title : string;
        starts_at : string;
        venue_name : string;
    };
    qr_payload : string;
};

type CheckInResponse = {
    result : "valid" | "already_used" | "cancelled" | "refunded" | "not_found" | "wrong_event";
    ticket : Ticket | null;
    checked_in_at : string | null;
};

type AuthResponse = {
    user: User;
    token: string;
}



async function apiGet<T> (path: string): Promise<T> {
    const url = `${API_URL}${path}`;
    let response : Response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization" : `Bearer ${await getAuth() ?? ""}`
            }
        });
    } catch (error) {
        // TODO: Dedicated api error handling
        throw new Error(`Failed to get from ${url}: ${error}`);
    }
    return (await response.json()) as T;
}

async function apiOther<T>(path: string, request: string, what?: object): Promise<T> {
    const url = `${API_URL}${path}`;
    let response : Response;
    try {
        response = await fetch(url, {
            method: request,
            headers: {
                "Authorization" : `Bearer ${await getAuth() ?? ""}`,
                "Content-Type": "appliction/json"
            },
            body: JSON.stringify(what ?? {})
        });
    } catch (error) {
        // TODO: Dedicated api error handling
        throw new Error(`Failed to post to ${url}: ${error}`);
    }
    return (await response.json()) as T;
}

async function apiPost<T>(path: string, body?: object): Promise<T> {
    return apiOther<T>(path, "POST", body);
}

async function apiPatch(path: string, body?: object) {
    return apiOther(path, "PATCH", body);
}

async function apiDelete(path: string, body?: object) {
    return apiOther(path, "DELETE", body);
}


    // GET REQUESTS (that work without auth)

export async function listEvents(): Promise<EventListItem[]> {
    return (await apiGet<EventListResponse>('/events')).events;
}

export async function getEvent(id: string): Promise<EventDetail> {
    return (await apiGet<{ event: EventDetail }>(`/events/${encodeURIComponent(id)}`)).event;
}

export async function listOrders() /* : Promise<Order[]> */ {

}

export async function getOrder(id: string) /* : Promise<Order> */ {
    
}

export async function listTickets() /* : Promise<Ticket[]> */ {

}

export async function getTicket(id: string) /* : Promise<Ticket> */ {
    
}

export async function listStaffEvents() /* : Promise<Event> */ {
    
}

export async function listStaffEventAttedees(id: string) /* : Promise<User> */ {
    
}

export async function getUser() : Promise<User> { // /auth/me
    return (await apiGet<{user : User}>("/api/auth/me")).user;
}


    // POST REQUESTS

export async function checkin(qrPayload: string) /* : Promise<CheckInResponse> */ {
    
}

export async function undoCheckin(ticketId: string) {

}

export async function registerUser(email: string, password: string, name: string) : Promise<AuthResponse> {
    let body = {"email": email, "password": password, "name": name};
    return apiPost<AuthResponse>("/auth/register", body);
}

export async function loginUser(email: string, password: string) : Promise<AuthResponse> {
    return apiPost<AuthResponse>("/auth/login", {"email": email, "password": password});
}

export async function createEvent(event: EventDetail) {

}

export async function publishEvent(eventId: string) {

}

export async function addEventTickets(eventId: string, tickets: TicketType[]) {

}

export async function createOrder(eventId: string, items: OrderRequest[]) {

}

export async function payOrder(orderId: string) {

}


    //PATCH REQUESTS

export async function editEventTickets(ticketTypeId: string) {

}

export async function editEvent(eventId: string) {

}


    //DELETE REQUESTS

export async function removeEventTickets(ticketTypeId: string) {

}
