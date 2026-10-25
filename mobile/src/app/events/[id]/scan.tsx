import { useCallback, useRef, useState } from "react";
import {
    ActivityIndicator,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useLocalSearchParams } from "expo-router";
import { CheckInResponse, checkIn, undoCheckIn } from "@/api";
import { styles } from "@/global";
import { formatTime } from "@/format";

// Everything the result screen can show. Errors from the API (for example
// 403 not assigned) are results too: a red screen with the message, not a crash.
type ResultState =
    | { kind: "checkin"; response: CheckInResponse }
    | { kind: "undone" }
    | { kind: "error"; message: string };

const RESULT_WORDS: Record<CheckInResponse["result"], string> = {
    valid: "Valid",
    already_used: "Already used",
    cancelled: "Cancelled",
    refunded: "Refunded",
    invalid: "Not a BiletFlow ticket",
    not_found: "Not found",
    wrong_event: "Ticket for another event",
};

export default function Scan() {
    const params = useLocalSearchParams<{ id: string; title?: string }>();
    const eventId = params.id;
    const title = params.title ?? "Scan";

    const [permission, requestPermission] = useCameraPermissions();
    const [result, setResult] = useState<ResultState | null>(null);
    const [scanning, setScanning] = useState(true);
    const [undoing, setUndoing] = useState(false);

    // onBarcodeScanned fires many times per second while a code is in view.
    // The lock is a ref so it is set synchronously inside the handler: state
    // updates round-trip through React and let duplicate scans through.
    const locked = useRef(false);

    const handleScan = useCallback(
        async ({ data }: BarcodeScanningResult) => {
            if (locked.current) return;
            locked.current = true;
            try {
                setResult({ kind: "checkin", response: await checkIn(eventId, data) });
            } catch (err) {
                setResult({
                    kind: "error",
                    message: err instanceof Error ? err.message : "Something went wrong",
                });
            }
            setScanning(false);
        },
        [eventId],
    );

    function scanNext() {
        locked.current = false;
        setResult(null);
        setUndoing(false);
        setScanning(true);
    }

    async function undo() {
        if (result?.kind !== "checkin" || result.response.ticket === null) return;
        setUndoing(true);
        try {
            await undoCheckIn(result.response.ticket.id);
            setResult({ kind: "undone" });
        } catch (err) {
            setResult({
                kind: "error",
                message: err instanceof Error ? err.message : "Something went wrong",
            });
        } finally {
            setUndoing(false);
        }
    }

    if (permission === null) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    if (!permission.granted) {
        return (
            <View style={styles.centered}>
                <Text style={styles.text}>
                    The camera is needed to scan tickets. BiletFlow uses it only for that.
                </Text>
                <TouchableOpacity style={styles.button} onPress={requestPermission}>
                    <Text style={styles.buttonText}>Ask for permission again</Text>
                </TouchableOpacity>
            </View>
        );
    }

    if (result !== null) {
        return <ResultView result={result} undoing={undoing} onUndo={undo} onNext={scanNext} />;
    }

    return (
        <View style={styles.container}>
            <Text style={styles.screenTitle}>{title}</Text>
            <View style={{ flex: 1 }}>
                <CameraView
                    style={styles.camera}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    // No handler while locked: a second scan cannot even reach the lock.
                    onBarcodeScanned={scanning ? handleScan : undefined}
                />
            </View>
        </View>
    );
}

function ResultView({
    result,
    undoing,
    onUndo,
    onNext,
}: {
    result: ResultState;
    undoing: boolean;
    onUndo: () => void;
    onNext: () => void;
}) {
    if (result.kind === "error") {
        return (
            <View style={[styles.resultFullScreen, styles.resultError]}>
                <Text style={styles.resultWord}>Error</Text>
                <Text style={styles.resultDetail}>{result.message}</Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={onNext}>
                    <Text style={styles.secondaryButtonText}>Scan next</Text>
                </TouchableOpacity>
            </View>
        );
    }

    if (result.kind === "undone") {
        return (
            <View style={[styles.resultFullScreen, styles.resultValid]}>
                <Text style={styles.resultWord}>Undone</Text>
                <Text style={styles.resultDetail}>Check-in undone</Text>
                <TouchableOpacity style={styles.secondaryButton} onPress={onNext}>
                    <Text style={styles.secondaryButtonText}>Scan next</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const { response } = result;
    const valid = response.result === "valid";

    return (
        <View style={[styles.resultFullScreen, valid ? styles.resultValid : styles.resultError]}>
            <Text style={styles.resultWord}>{RESULT_WORDS[response.result]}</Text>
            {response.ticket !== null && (
                <>
                    <Text style={styles.resultDetail}>{response.ticket.attendee_name}</Text>
                    <Text style={styles.resultDetail}>{response.ticket.ticket_type_name}</Text>
                    <Text style={styles.resultDetail}>{response.ticket.code}</Text>
                </>
            )}
            {response.result === "already_used" && response.checked_in_at !== null && (
                <Text style={styles.resultDetail}>
                    Checked in at {formatTime(response.checked_in_at)}
                </Text>
            )}
            {valid && (
                <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={onUndo}
                    disabled={undoing}
                >
                    {undoing ? (
                        <ActivityIndicator color="#208AEF" />
                    ) : (
                        <Text style={styles.secondaryButtonText}>Undo check-in</Text>
                    )}
                </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.secondaryButton} onPress={onNext}>
                <Text style={styles.secondaryButtonText}>Scan next</Text>
            </TouchableOpacity>
        </View>
    );
}
