import { View, Text, ActivityIndicator } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { EventDetail, getEvent } from "@/api"
import { useEffect, useState } from "react";
import { styles } from "@/global";



export default function Event() {
    const params = useLocalSearchParams();
    const eventId = Array.isArray(params.id) ? params.id[0] : params.id;

    const [isLoading, setLoading] = useState(true);
    const [data, setData] = useState<EventDetail>();

    useEffect(() => {
        async function loadData() {
            try {
                setData(await getEvent(eventId));
            } catch (error) {
                console.error(error);
            } finally {
                setLoading(false);
            }
        }

        loadData();
    }, []);
    
    return (
        <View style={styles.container}>
                {
                    isLoading ? (
                        <ActivityIndicator />
                    ) : (
                        
                        <Text>
                            Welcome to /events/{eventId}: {data?.title}!
                        </Text>
)
                }
        </View>
    )
}