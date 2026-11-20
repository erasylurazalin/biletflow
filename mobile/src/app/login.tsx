import { useEffect, useState } from "react";
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { Redirect, router } from "expo-router";
import { isLoggedIn } from "@/auth";
import { loginUser } from "@/api";
import { styles } from "@/global";

export default function Login() {
    const [checked, setChecked] = useState(false);
    const [loggedIn, setLoggedIn] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // A logged-in user skips the login screen.
    useEffect(() => {
        isLoggedIn()
            .then(setLoggedIn)
            .finally(() => setChecked(true));
    }, []);

    async function submit() {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            await loginUser(email.trim(), password);
            router.replace("/events");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong");
            setSubmitting(false);
        }
    }

    if (!checked) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" />
            </View>
        );
    }
    if (loggedIn) {
        return <Redirect href="/events" />;
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
            <Text style={styles.screenTitle}>BiletFlow door staff</Text>
            <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor="#999999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                value={email}
                onChangeText={setEmail}
            />
            <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#999999"
                secureTextEntry
                textContentType="password"
                value={password}
                onChangeText={setPassword}
            />
            {error !== null && <Text style={styles.errorText}>{error}</Text>}
            <TouchableOpacity
                style={[styles.button, submitting && styles.buttonDisabled]}
                onPress={submit}
                disabled={submitting}
            >
                {submitting ? (
                    <ActivityIndicator color="#FFFFFF" />
                ) : (
                    <Text style={styles.buttonText}>Log in</Text>
                )}
            </TouchableOpacity>
        </KeyboardAvoidingView>
    );
}
