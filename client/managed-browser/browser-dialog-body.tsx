/** Shared confirmation layout for short Shared Browser dialogs. */
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { createStyles } from "./browser-panel-styles";

/** Keep confirmation copy and actions aligned within the host modal's own inset. */
export function BrowserDialogBody({
  styles,
  children,
  actions,
}: {
  styles: ReturnType<typeof createStyles>;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <View style={styles.dialogBody}>
      <Text style={styles.dialogMessage}>{children}</Text>
      <View style={styles.dialogActions}>{actions}</View>
    </View>
  );
}
