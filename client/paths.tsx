import React from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { pathWidth, truncateMiddle } from "../shared/paths";
import { redactSecrets } from "../shared/redaction";
import { useCopy } from "./feedback";
import { Button, Meta, Row, SPACE } from "./kit";

/**
 * File references (0.15.0): the friendly label in plain view, shortened in
 * the middle on narrow screens; the full path only in an opened row, with
 * Copy path. Both pass the redactor.
 */

export function PathLabel({ theme, label, compact, prefix }: { theme: PluginTheme; label: string; compact: boolean; prefix?: string }) {
  return <Meta theme={theme}>{`${prefix ?? ""}${truncateMiddle(redactSecrets(label), pathWidth(compact))}`}</Meta>;
}

export function PathDetails({ theme, full }: { theme: PluginTheme; full: string }) {
  const copy = useCopy();
  const safe = redactSecrets(full);
  return (
    <View style={{ gap: SPACE.xs }}>
      <Meta theme={theme} selectable>{safe}</Meta>
      <Row><Button theme={theme} label="Copy path" icon="Copy" accessibilityLabel={`Copy the path ${safe}`} onPress={() => void copy(full, "Path copied")} /></Row>
    </View>
  );
}
