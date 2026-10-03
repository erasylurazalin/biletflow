import * as Store from "expo-secure-store";

const TOKEN_KEY = "user_auth_token";
let logged_in : boolean|null = null;

export async function setAuth(token : string) : Promise<void> {
    try {
        await Store.setItemAsync(TOKEN_KEY, token);
    } catch (error) {
        console.error("Error saving the auth token:", error);
    }
}

export async function getAuth() : Promise<string|null>{
    try {
        return await Store.getItemAsync(TOKEN_KEY);
    } catch (error) {
        console.error("Error setching the auth token:", error);
        return null;
    }
}    

export async function removeAuth() {
    try {
        await Store.deleteItemAsync(TOKEN_KEY);
    } catch (error) {
        console.error("Error deleting the auth token:", error);
    }
}

export async function isLoggedIn() {
    if (logged_in !== null) return logged_in;
    
    logged_in = await getAuth() !== null;
    return logged_in;
}


