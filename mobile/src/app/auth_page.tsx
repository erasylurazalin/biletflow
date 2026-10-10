import { View, Text, TouchableOpacity, ActivityIndicator} from "react-native";
import { Redirect } from "expo-router";
import { getAuth, setAuth } from "@/auth";
import { loginUser, registerUser } from "@/api";
import { useEffect, useState } from "react";

export default function authPage() {
    const [login, setLogin] = useState<boolean>(true);
    const [isLoading, setLoading] = useState(true);
    const [authToken, setAuthToken] = useState<string|null>(null);
    useEffect(() => {
        async function checkAuth() {
            try {
                setAuthToken(await getAuth());
            } catch (error) {
                console.error(error);
            } finally {
                setLoading(false);
            }
        }
        checkAuth();
    }, []);
    if (isLoading) return (<ActivityIndicator/>);
    if (authToken !== null) return (<Redirect href="/" />);

    //TODO: user input and the rest

    if (login) return (
        <View>
            <TouchableOpacity onPress={() => {setLogin(false)}}>
                <Text>Register</Text>
            </TouchableOpacity>
        </View>
    );
    else return (
        <View>
            <TouchableOpacity onPress={() => {setLogin(true)}}>
                <Text>Log in</Text>
            </TouchableOpacity>
        </View>
    );
}