import * as Store from "expo-secure-store";

const TOKEN_KEY = "user_auth_token";

export async function setAuth(token: string): Promise<void> {
    try {
        await Store.setItemAsync(TOKEN_KEY, token);
    } catch (error) {
        console.error("Error saving the auth token:", error);
    }
}

export async function getAuth(): Promise<string | null> {
    try {
        return await Store.getItemAsync(TOKEN_KEY);
    } catch (error) {
        console.error("Error fetching the auth token:", error);
        return null;
    }
}

export async function removeAuth(): Promise<void> {
    try {
        await Store.deleteItemAsync(TOKEN_KEY);
    } catch (error) {
        console.error("Error deleting the auth token:", error);
    }
}

// Always reads the stored token: it can be set or cleared while the app runs.
export async function isLoggedIn(): Promise<boolean> {
    return (await getAuth()) !== null;
}
