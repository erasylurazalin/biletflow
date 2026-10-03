import { View, Text, ActivityIndicator } from "react-native"
import { Redirect } from "expo-router";
import { getAuth, removeAuth } from "@/auth";
import { getUser, User } from "@/api";
import { useEffect, useState } from "react";

export default function Profile() {

    let [login, setLogin] = useState<string|null>(null);
    let [profile, setProfile] = useState<User|null>(null);
    let [loading, setLoading] = useState<boolean>(true);

    useEffect(() => {
        async function checkAuth() {
            try {
                setLogin(await getAuth());
                if (login !== null) setProfile(await getUser());
            } catch (error) {
                console.error(error);
            } finally {
                setLoading(false);
            }
        }

        checkAuth();
    });
    
    if (loading) return (<ActivityIndicator/>);
    if (login === null) return (<Redirect href={"/auth_page"}/>);

    return getAuth() !== null ? (
        <View>
            <Text>
                Welcome, {profile?.name}!
            </Text>
        </View>
    ) : (<Redirect href="../auth_page"/>);
}