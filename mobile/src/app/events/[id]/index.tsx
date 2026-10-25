import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity } from "react-native";
import { Link, useFocusEffect, useLocalSearchParams } from "expo-router";
import { AttendeeCounts, listAttendees } from "@/api";
import { colors, styles } from "@/global";

export default function EventScreen() {
    const params = useLocalSearchParams<{ id: string; title?: string }>();
    const id = params.id;
    const title = params.title ?? "Event";

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [counts, setCounts] = useState<AttendeeCounts | null>(null);
    const [error, setError] = useState<string | null>(null);

    const loadCounts = useCallback(async () => {
        setError(null);
        try {
            setCounts((await listAttendees(id)).counts);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong");
        }
    }, [id]);

    // Refetch on every focus: the counts change while the scanner is open.
    useFocusEffect(
        useCallback(() => {
            loadCounts().finally(() => setLoading(false));
        }, [loadCounts]),
    );

    async function refresh() {
        setRefreshing(true);
        await loadCounts();
        setRefreshing(false);
    }

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={{ gap: 16, paddingBottom: 32 }}
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.blue} />
            }
        >
            <Text style={styles.screenTitle}>{title}</Text>
            {loading ? (
                <ActivityIndicator size="large" />
            ) : error !== null ? (
                <Text style={styles.errorText}>{error}</Text>
            ) : (
                counts !== null && (
                    <Text style={styles.text}>
                        Checked in {counts.checked_in} of {counts.registered}
                    </Text>
                )
            )}
            <Link href={`/events/${id}/scan?title=${encodeURIComponent(title)}`} asChild>
                <TouchableOpacity style={styles.button}>
                    <Text style={styles.buttonText}>Scan</Text>
                </TouchableOpacity>
            </Link>
            <Link href={`/events/${id}/attendees?title=${encodeURIComponent(title)}`} asChild>
                <TouchableOpacity style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Attendees</Text>
                </TouchableOpacity>
            </Link>
        </ScrollView>
    );
}
