import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    FlatList,
    RefreshControl,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { AttendeeCounts, CheckInTicket, listAttendees, undoCheckIn } from "@/api";
import { colors, styles } from "@/global";
import { formatTime } from "@/format";

function statusBadge(ticket: CheckInTicket) {
    const checkedIn = ticket.status === "checked_in";
    return (
        <View style={[styles.badge, checkedIn ? styles.badgeCheckedIn : styles.badgeValid]}>
            <Text style={styles.badgeText}>{checkedIn ? "CHECKED IN" : "VALID"}</Text>
        </View>
    );
}

export default function Attendees() {
    const params = useLocalSearchParams<{ id: string; title?: string }>();
    const eventId = params.id;
    const title = params.title ?? "Attendees";

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [attendees, setAttendees] = useState<CheckInTicket[]>([]);
    const [counts, setCounts] = useState<AttendeeCounts | null>(null);
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);

    const searchRef = useRef(search);
    searchRef.current = search;

    const load = useCallback(
        async (q: string) => {
            setError(null);
            try {
                const response = await listAttendees(eventId, q);
                setAttendees(response.attendees);
                setCounts(response.counts);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Something went wrong");
            }
        },
        [eventId],
    );

    // Search is sent after the user stops typing for about 300 ms. The first
    // change is skipped: useFocusEffect above already loaded the list on focus.
    const firstSearch = useRef(true);
    useEffect(() => {
        if (firstSearch.current) {
            firstSearch.current = false;
            return;
        }
        const timer = setTimeout(() => {
            load(searchRef.current).finally(() => setLoading(false));
        }, 300);
        return () => clearTimeout(timer);
    }, [search, load]);

    useFocusEffect(
        useCallback(() => {
            load(searchRef.current).finally(() => setLoading(false));
        }, [load]),
    );

    async function refresh() {
        setRefreshing(true);
        await load(searchRef.current);
        setRefreshing(false);
    }

    function confirmUndo(ticket: CheckInTicket) {
        Alert.alert(
            "Undo check-in",
            `Undo check-in for ${ticket.attendee_name} (${ticket.code})?`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Undo",
                    style: "destructive",
                    onPress: () => {
                        undoCheckIn(ticket.id)
                            .then(() => load(searchRef.current))
                            .catch((err: unknown) =>
                                setError(
                                    err instanceof Error
                                        ? err.message
                                        : "Something went wrong",
                                ),
                            );
                    },
                },
            ],
        );
    }

    return (
        <View style={styles.container}>
            <Text style={styles.screenTitle}>{title}</Text>
            {counts !== null && (
                <Text style={styles.text}>
                    Checked in {counts.checked_in} of {counts.registered}
                </Text>
            )}
            <TextInput
                style={styles.input}
                placeholder="Search name or code"
                placeholderTextColor="#999999"
                autoCapitalize="none"
                autoCorrect={false}
                value={search}
                onChangeText={setSearch}
                returnKeyType="search"
            />
            {error !== null && <Text style={styles.errorText}>{error}</Text>}
            <FlatList
                data={attendees}
                keyExtractor={({ id }) => id}
                ListEmptyComponent={
                    loading ? (
                        <ActivityIndicator size="large" />
                    ) : error === null ? (
                        <Text style={styles.mutedText}>No attendees found</Text>
                    ) : null
                }
                renderItem={({ item }) => (
                    <View style={styles.listRow}>
                        <Text style={styles.text}>{item.attendee_name}</Text>
                        <Text style={styles.mutedText}>{item.ticket_type_name}</Text>
                        <Text style={styles.mutedText}>{item.code}</Text>
                        {item.checked_in_at !== null && (
                            <Text style={styles.mutedText}>
                                Checked in at {formatTime(item.checked_in_at)}
                            </Text>
                        )}
                        {statusBadge(item)}
                        {item.status === "checked_in" && (
                            <TouchableOpacity
                                style={styles.secondaryButton}
                                onPress={() => confirmUndo(item)}
                            >
                                <Text style={styles.secondaryButtonText}>Undo</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                )}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={refresh}
                        tintColor={colors.blue}
                    />
                }
            />
        </View>
    );
}
