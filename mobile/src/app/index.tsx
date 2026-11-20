import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { isLoggedIn } from "@/auth";
import { styles } from "@/global";

// Route gate: a logged-in user goes to their events, everybody else to login.
export default function Index() {
    const [checked, setChecked] = useState(false);
    const [loggedIn, setLoggedIn] = useState(false);

    useEffect(() => {
        isLoggedIn()
            .then(setLoggedIn)
            .finally(() => setChecked(true));
    }, []);

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
    return <Redirect href="/login" />;
}
