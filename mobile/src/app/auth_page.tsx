import { View, Text, Pressable, ActivityIndicator, TextInput} from "react-native";
import { useRouter } from "expo-router";
import { getAuth, setAuth } from "@/auth";
import { loginUser, registerUser } from "@/api";
import { useState, useEffect } from "react";


const nameInput = (name: string|null, onChange: Function) => (
    <TextInput
        placeholder="name"
        onChangeText={value => {checkName(value, onChange)}}
        value={name??""}
    />
);
const emailInput = (email: string|null, onChange: Function) => (
    <TextInput
        placeholder="email"
        onChangeText={value => {onChange(value)}}
        autoComplete="email"
        onEndEditing={() => checkEmail(email??"")}
        value={email??""}
    />
);
const passwordInput = (password: string|null, onChange: Function) => (
    <TextInput
        placeholder="password"
        onChangeText={value => {onChange(value)}}
        secureTextEntry
    />
)
let allow = false;


function checkEmail(email: string) {
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    allow = EMAIL_REGEX.test(email);
    if (!allow) console.warn(email, "is not a valid email");
}
function checkName(name: string, setter: Function) {
    if (/^[A-Za-z]+[A-Za-z\s]*$/.test(name)) setter(name);
}


export default function authPage() {
    const [login, setLogin] = useState<boolean>(true);
    const [isLoading, setLoading] = useState(true);
    const [authToken, setAuthToken] = useState<string|null>(null);
    const [name, setName] = useState<string|null>(null);
    const [email, setEmail] = useState<string|null>(null);
    const [password, setPassword] = useState<string|null>(null);
    const router = useRouter();

    const registerRequest = async () => {
        try {
            setAuth((await registerUser(email??"", password??"", name??"")).token);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
            router.navigate("/(tabs)/profile");
        }
    }
    const loginRequest = async () => {
        try {
            setAuth((await loginUser(email??"", password??"")).token);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
            router.navigate("/(tabs)/profile");
        }
    }

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

    if (login) return (
        <View>
            <Pressable onPress={() => {setLogin(false)}}>
                <Text>Register</Text>
            </Pressable>
            {emailInput(email, setEmail)}
            {passwordInput(password, setPassword)}
            <Pressable disabled={!allow || password === null || password === "" || isLoading} onPress={loginRequest}>
                <Text>Log in</Text>
            </Pressable>
        </View>
    );
    else return (
        <View>
            <Pressable onPress={() => {setLogin(true)}}>
                <Text>Log in</Text>
            </Pressable>
            {nameInput(name,setName)}
            {emailInput(email, setEmail)}
            {passwordInput(password, setPassword)}
            <Pressable disabled={!allow || password === null || password === "" || name === null || isLoading} onPress={registerRequest}>
                <Text>Register</Text>
            </Pressable>
        </View>
    );
}