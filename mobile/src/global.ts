import { StyleSheet } from "react-native";

// Door styles: large text and buttons, high contrast, readable in a hurry.
const colors = {
    blue: "#208AEF",
    green: "#1E8E3E",
    red: "#C5221F",
    white: "#FFFFFF",
    text: "#111111",
    mutedText: "#555555",
    border: "#CCCCCC",
    cancelledBackground: "#F6DEDD",
};

export { colors };

export const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: "stretch",
        justifyContent: "flex-start",
        padding: 16,
        gap: 12,
    },
    centered: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        gap: 12,
    },
    screenTitle: {
        fontSize: 28,
        fontWeight: "bold",
        color: colors.text,
    },
    text: {
        fontSize: 18,
        color: colors.text,
    },
    mutedText: {
        fontSize: 16,
        color: colors.mutedText,
    },
    errorText: {
        fontSize: 18,
        color: colors.red,
    },
    button: {
        backgroundColor: colors.blue,
        padding: 18,
        borderRadius: 8,
        alignItems: "center",
    },
    buttonDisabled: {
        backgroundColor: colors.border,
    },
    buttonText: {
        fontSize: 20,
        fontWeight: "bold",
        color: colors.white,
    },
    secondaryButton: {
        backgroundColor: colors.white,
        borderWidth: 2,
        borderColor: colors.blue,
        padding: 18,
        borderRadius: 8,
        alignItems: "center",
    },
    secondaryButtonText: {
        fontSize: 20,
        fontWeight: "bold",
        color: colors.blue,
    },
    input: {
        borderWidth: 2,
        borderColor: colors.border,
        borderRadius: 8,
        padding: 14,
        fontSize: 18,
        color: colors.text,
    },
    listRow: {
        padding: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 4,
    },
    cancelledRow: {
        backgroundColor: colors.cancelledBackground,
    },
    badge: {
        alignSelf: "flex-start",
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    badgeCancelled: {
        backgroundColor: colors.red,
    },
    badgeCheckedIn: {
        backgroundColor: colors.green,
    },
    badgeValid: {
        backgroundColor: colors.blue,
    },
    badgeText: {
        color: colors.white,
        fontSize: 14,
        fontWeight: "bold",
    },
    // Full-screen scan result.
    resultFullScreen: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 16,
    },
    resultValid: {
        backgroundColor: colors.green,
    },
    resultError: {
        backgroundColor: colors.red,
    },
    resultWord: {
        fontSize: 48,
        fontWeight: "bold",
        color: colors.white,
        textAlign: "center",
    },
    resultDetail: {
        fontSize: 24,
        color: colors.white,
        textAlign: "center",
    },
    camera: {
        flex: 1,
    },
});
