import { useCameraPermissions, CameraView } from "expo-camera";
import { Text, TouchableHighlight, View } from "react-native";


async function verifyTicket(qr:string) {
    console.log(qr);
}

export default function Index() {
    const [permission, requestPermission] = useCameraPermissions();
    const isPermissionGranted = Boolean(permission?.granted);

    if (!isPermissionGranted) return (
        <View>
            <TouchableHighlight onPress={requestPermission}>
                <Text>Request Camera Permission</Text>
            </TouchableHighlight>
        </View>
    );

    return (
        <View>
            <CameraView
                facing="back"
                barcodeScannerSettings={
                    {barcodeTypes: ['qr']}
                }
                onBarcodeScanned={({data}) => verifyTicket(data)}
            />
        </View>
    );
}

