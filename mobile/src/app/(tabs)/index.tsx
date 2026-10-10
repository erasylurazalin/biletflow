import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableWithoutFeedback, View } from 'react-native';
import { styles } from "@/global";
import { EventListItem, listEvents } from "@/api";
import { Link } from 'expo-router';


function eventListElement(event: EventListItem) {
    return (
        <Link href={`/events/${event.id}`} asChild>
            <TouchableWithoutFeedback>
                <Text>{event.title}</Text>
            </TouchableWithoutFeedback>
        </Link>
    )
}

//TODO: test this plz, but on monday, 28th
export function eventList(data: EventListItem[] ) {
    return (
          <FlatList
            data={data}
            keyExtractor={({id}) => id}
            renderItem={
                ({item}) => eventListElement(item)
            }
          />
    );
}

export default function Index() {

	const [isLoading, setLoading] = useState(true);
	const [data, setData] = useState<EventListItem[]>([]);

	useEffect(() => {
		async function loadData() {
			try {
				setData(await listEvents());
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
				eventList(data)
			)
		}
		</View>
	);
}
