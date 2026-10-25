import { useCallback, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    RefreshControl,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { Link, router, useFocusEffect } from "expo-router";
import { EventListItem, EventStatus, listStaffEvents } from "@/api";
import { removeAuth } from "@/auth";
import { colors, styles } from "@/global";
import { formatDateTime } from "@/format";

const EMPTY_MESSAGE =
    "You are not assigned to any events yet. Ask the organizer to add you to the door staff.";

function statusBadge(status: EventStatus) {
    const label = status === "cancelled" ? "CANCELLED" : status.toUpperCase();
    return (
        <View style={[styles.badge, status === "cancelled" && styles.badgeCancelled]}>
            <Text style={styles.badgeText}>{label}</Text>
        </View>
    );
}

// Cancelled events cannot be scanned, so they are shown but not pressable.
function EventRow({ event }: { event: EventListItem }) {
    const body = (
        <>
            <Text style={styles.text}>{event.title}</Text>
            <Text style={styles.mutedText}>{formatDateTime(event.starts_at)}</Text>
            <Text style={styles.mutedText}>{event.venue_name}</Text>
            {statusBadge(event.status)}
        </>
    );

    if (event.status === "cancelled") {
        return <View style={[styles.listRow, styles.cancelledRow]}>{body}</View>;
    }
    return (
        <Link
            href={{
                pathname: "/events/[id]",
                params: { id: event.id, title: event.title },
            }}
            asChild
        >
            <TouchableOpacity style={styles.listRow}>{body}</TouchableOpacity>
        </Link>
    );
}

export default function Events() {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [events, setEvents] = useState<EventListItem[]>([]);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setEvents(await listStaffEvents());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong");
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            load().finally(() => setLoading(false));
        }, [load]),
    );

    async function refresh() {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }

    function logout() {
        Alert.alert("Log out", "Log out of BiletFlow?", [
            { text: "Cancel", style: "cancel" },
            {
                text: "Log out",
                style: "destructive",
                onPress: () => {
                    removeAuth();
                    router.replace("/login");
                },
            },
        ]);
    }

    return (
        <View style={styles.container}>
            {loading ? (
                <ActivityIndicator size="large" />
            ) : events.length === 0 && error === null ? (
                <Text style={styles.text}>{EMPTY_MESSAGE}</Text>
            ) : (
                <FlatList
                    data={events}
                    keyExtractor={({ id }) => id}
                    renderItem={({ item }) => <EventRow event={item} />}
                    ListEmptyComponent={
                        error !== null ? <Text style={styles.errorText}>{error}</Text> : null
                    }
                    refreshControl={
                        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.blue} />
                    }
                />
            )}
            {error !== null && events.length > 0 && (
                <Text style={styles.errorText}>{error}</Text>
            )}
            <TouchableOpacity style={styles.secondaryButton} onPress={logout}>
                <Text style={styles.secondaryButtonText}>Log out</Text>
            </TouchableOpacity>
        </View>
    );
}
