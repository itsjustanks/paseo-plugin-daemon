// The shared Paseo plugin design standard's primitives, copied from AI Router 0.15.0's client/ui.tsx
// (itsjustanks/paseo-plugin-ai-router, MIT) so the two plugins look and read the same. Keep in step with it.
import React, { useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

type Theme = PluginTheme;
export type Tone = "success" | "warning" | "danger" | "neutral";

/**
 * One type scale for the whole panel, so sentences stay readable: nothing
 * below 13 px, descriptions at 15, section titles at 17, tab titles at 20 and
 * the page title at 22; headline numbers get 26. Spread one into a style:
 * `{ ...TYPE.body, color }`.
 */
export const TYPE = {
  page: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  tabTitle: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  section: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  lead: { fontSize: 16, lineHeight: 24 },
  item: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22 },
  secondary: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  /** A headline number, such as a usage total. */
  figure: { fontSize: 26, lineHeight: 32, fontWeight: "700" },
} as const;

/**
 * One spacing scale for the whole panel. Screens use these names, never raw
 * numbers: `section` between cards, `card` inside them, `row` between the
 * lines of a card, `sm`/`xs`/`hair` for tight pairs (an icon and its text).
 */
export const SPACE = { hair: 2, xs: 4, sm: 8, row: 12, md: 16, card: 20, section: 24 } as const;
export const RADIUS = { card: 16, control: 10, pill: 999 } as const;

/** The app's icon component, when the host provides one (Paseo 0.9 does). Lucide names. */
export const HostIcon = (HostRN as unknown as { Icon?: React.ComponentType<{ name: string; size?: number; color?: string }> }).Icon;

export function toneColor(theme: Theme, tone: Tone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

/** A theme colour at `alpha` opacity, for soft fills; null when the colour is not hex or rgb(), so callers fall back to a surface. */
export function tint(color: string, alpha: number): string | null {
  const value = String(color ?? "").trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  let rgb: number[] | null = null;
  if (hex) {
    const full = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  } else {
    const fn = value.match(/^rgba?\(([^)]+)\)$/i);
    if (fn) rgb = fn[1].split(",").slice(0, 3).map((n) => Number.parseFloat(n));
  }
  if (!rgb || rgb.length !== 3 || rgb.some((n) => !Number.isFinite(n))) return null;
  return `rgba(${rgb.join(", ")}, ${alpha})`;
}

/** The colour an accent-or-tone element is drawn in: the theme accent unless a status tone is asked for. */
function inkOf(theme: Theme, tone: Tone | "accent"): string {
  return tone === "accent" ? theme.colors.accent : toneColor(theme, tone);
}

/** A soft circle with an icon in it: the visual anchor of cards, steps and status. Nothing without the app's icons. */
export function IconBadge({ theme, name, tone = "accent", size = 32 }: { theme: Theme; name: string; tone?: Tone | "accent"; size?: number }) {
  if (!HostIcon) return null;
  const color = inkOf(theme, tone);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint(color, 0.14) ?? theme.colors.surface2, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <HostIcon name={name} size={Math.round(size * 0.5)} color={color} />
    </View>
  );
}

/** A box for one topic. `flush` drops the space below it, for a card that is the last thing in a group. */
export function Card({ theme, title, icon, tone = "accent", subtitle, flush, children }: { theme: Theme; title?: string; icon?: string; tone?: Tone | "accent"; subtitle?: string; flush?: boolean; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.card, padding: SPACE.card, gap: SPACE.row, marginBottom: flush ? 0 : SPACE.section }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
          {icon ? <IconBadge theme={theme} name={icon} tone={tone} size={32} /> : null}
          <View style={{ flex: 1, gap: SPACE.hair }}>
            <Text style={{ ...TYPE.section, color: theme.colors.foreground }}>{title}</Text>
            {subtitle ? <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted }}>{subtitle}</Text> : null}
          </View>
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Chip({ theme, label, tone = "neutral" }: { theme: Theme; label: string; tone?: Tone }) {
  const color = toneColor(theme, tone);
  return (
    <View style={{ alignSelf: "flex-start", borderColor: tint(color, 0.55) ?? color, borderWidth: 1, backgroundColor: tint(color, 0.1) ?? "transparent", borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm + SPACE.hair, paddingVertical: SPACE.hair }}>
      <Text style={{ ...TYPE.small, color: tone === "neutral" ? theme.colors.foreground : color, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/** `danger` (Daemon Link's one addition to the shared kit) is for a confirmed destructive action, such as Stop. */
export function Button({ theme, label, onPress, primary, danger, busy, disabled, icon, accessibilityLabel }: { theme: Theme; label: string; onPress: () => void; primary?: boolean; danger?: boolean; busy?: boolean; disabled?: boolean; icon?: string; accessibilityLabel?: string }) {
  const inactive = disabled || busy;
  const color = danger ? theme.colors.statusDanger : primary ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={!!inactive}
      onPress={inactive ? undefined : onPress}
      style={{
        backgroundColor: danger ? tint(theme.colors.statusDanger, 0.12) ?? theme.colors.surface2 : primary ? theme.colors.accent : theme.colors.surface2,
        borderColor: danger ? tint(theme.colors.statusDanger, 0.5) ?? theme.colors.statusDanger : theme.colors.border,
        borderWidth: primary && !danger ? 0 : 1,
        borderRadius: RADIUS.control,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.sm + SPACE.hair,
        minHeight: 44,
        opacity: inactive ? 0.5 : 1,
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.sm,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : icon && HostIcon ? <HostIcon name={icon} size={16} color={color} /> : null}
      <Text style={{ ...TYPE.body, color, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ theme, label, value, onChangeText, placeholder, secure }: { theme: Theme; label: string; value: string; onChangeText: (next: string) => void; placeholder: string; secure?: boolean }) {
  return (
    <View style={{ gap: SPACE.xs }}>
      <Text style={{ ...TYPE.secondary, color: theme.colors.foreground, fontWeight: "500" }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.control, paddingHorizontal: SPACE.row, paddingVertical: SPACE.sm + SPACE.hair, color: theme.colors.foreground, fontSize: TYPE.body.fontSize }}
      />
    </View>
  );
}

/** A sentence of body text. Neutral notes use the full foreground colour, so what matters is never faint. */
export function Note({ theme, children, tone = "neutral" }: { theme: Theme; children: React.ReactNode; tone?: Tone }) {
  return <Text style={{ ...TYPE.body, color: tone === "neutral" ? theme.colors.foreground : toneColor(theme, tone) }}>{children}</Text>;
}

/** Secondary detail: times, ids, where something is stored. Muted, and never below 14 px. */
export function Meta({ theme, children, selectable }: { theme: Theme; children: React.ReactNode; selectable?: boolean }) {
  return <Text selectable={selectable} style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted }}>{children}</Text>;
}

/** A heading for one item inside a card, such as a provider or an account. */
export function ItemTitle({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return <Text style={{ ...TYPE.item, color: theme.colors.foreground, flexShrink: 1 }}>{children}</Text>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm }}>{children}</View>;
}

/** A quiet text action, for secondary links such as "Change in dashboard". */
export function Link({ theme, label, onPress, accessibilityLabel }: { theme: Theme; label: string; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} style={{ paddingVertical: SPACE.xs }}>
      <Text style={{ ...TYPE.body, color: theme.colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const BANNER_ICON: Record<Tone, string> = { success: "CircleCheck", warning: "TriangleAlert", danger: "CircleAlert", neutral: "Info" };

/** The one line that says what state things are in, above everything else. Neutral banners use the accent. */
export function Banner({ theme, tone, title, children }: { theme: Theme; tone: Tone; title: string; children?: React.ReactNode }) {
  const color = tone === "neutral" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <View style={{ backgroundColor: tint(color, 0.07) ?? theme.colors.surface1, borderColor: tint(color, 0.35) ?? theme.colors.border, borderWidth: 1, borderLeftWidth: 4, borderLeftColor: color, borderRadius: RADIUS.card, padding: SPACE.card, gap: SPACE.row, marginBottom: SPACE.section }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm + SPACE.hair }}>
        {HostIcon ? <View style={{ paddingTop: SPACE.hair }}><HostIcon name={BANNER_ICON[tone]} size={20} color={color} /></View> : null}
        <Text style={{ ...TYPE.section, fontWeight: "700", color: tone === "neutral" ? theme.colors.foreground : color, flex: 1 }}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/**
 * The big status card at the top of Overview: a coloured band with an icon
 * and the state in words, then whatever details and actions follow.
 * Neutral uses the accent, so "one step left" does not read as a warning.
 */
export function HeroCard({ theme, tone, icon, title, lead, children }: { theme: Theme; tone: Tone; icon: string; title: string; lead?: React.ReactNode; children?: React.ReactNode }) {
  const color = tone === "neutral" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderColor: tint(color, 0.4) ?? theme.colors.border, borderWidth: 1, borderRadius: RADIUS.card, overflow: "hidden", marginBottom: SPACE.section }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, padding: SPACE.card, backgroundColor: tint(color, 0.09) ?? theme.colors.surface2 }}>
        <IconBadge theme={theme} name={icon} tone={tone === "neutral" ? "accent" : tone} size={48} />
        <View style={{ flex: 1, gap: SPACE.xs }}>
          <Text accessibilityRole="header" style={{ ...TYPE.tabTitle, color: tone === "danger" ? color : theme.colors.foreground }}>{title}</Text>
          {lead ? <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{lead}</Text> : null}
        </View>
      </View>
      {children ? <View style={{ padding: SPACE.card, gap: SPACE.row }}>{children}</View> : null}
    </View>
  );
}

/** A plain label and value, such as an endpoint or a masked key. The value can be selected and copied. */
export function Fact({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: SPACE.row, rowGap: SPACE.hair }}>
      <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, width: 140 }}>{label}</Text>
      <Text selectable style={{ ...TYPE.body, color: theme.colors.foreground, flexShrink: 1 }}>{value}</Text>
    </View>
  );
}

/** Label on the left, value chip and hint on the right, and an optional link to the tab with the details. */
export function StatusLine({ theme, label, value, tone, hint, action }: { theme: Theme; label: string; value: string; tone: Tone; hint?: string | null; action?: { label: string; onPress: () => void } | null }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: SPACE.sm + SPACE.hair, rowGap: SPACE.xs, paddingVertical: SPACE.hair }}>
      <Text style={{ ...TYPE.body, color: theme.colors.foreground, fontWeight: "500", width: 160 }}>{label}</Text>
      <Chip theme={theme} label={value} tone={tone} />
      {hint ? <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{hint}</Text> : null}
      {action ? (
        <Pressable accessibilityRole="link" accessibilityLabel={action.label} onPress={action.onPress}>
          <Text style={{ ...TYPE.secondary, color: theme.colors.accent, fontWeight: "600" }}>{`${action.label} →`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** An on/off switch. `label` is what it switches, for screen readers. */
export function Toggle({ theme, label, value, onChange, busy, disabled }: { theme: Theme; label: string; value: boolean; onChange: (next: boolean) => void; busy?: boolean; disabled?: boolean }) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!inactive, busy: !!busy }}
      disabled={!!inactive}
      onPress={inactive ? undefined : () => onChange(!value)}
      style={{ width: 44, height: 26, borderRadius: 13, padding: SPACE.hair, backgroundColor: value ? theme.colors.accent : theme.colors.surface2, borderWidth: 1, borderColor: value ? theme.colors.accent : theme.colors.border, opacity: inactive ? 0.5 : 1, justifyContent: "center" }}
    >
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: value ? theme.colors.accentForeground : theme.colors.foregroundMuted, alignSelf: value ? "flex-end" : "flex-start" }} />
    </Pressable>
  );
}

/** A switch with its words beside it, at body size. */
export function ToggleRow({ theme, label, text, value, onChange, busy, disabled }: { theme: Theme; label: string; text: string; value: boolean; onChange: (next: boolean) => void; busy?: boolean; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
      <Toggle theme={theme} label={label} value={value} onChange={onChange} busy={busy} disabled={disabled} />
      <Text style={{ ...TYPE.body, color: theme.colors.foreground, fontWeight: "500", flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

/** A thin rule between the parts of a card. */
export function Divider({ theme }: { theme: Theme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

/** Short lines, each with a check mark in the accent colour. `columns` lays them out two across when there is room. */
export function Bullets({ theme, items, columns, icon = "Check" }: { theme: Theme; items: readonly string[]; columns?: boolean; icon?: string }) {
  return (
    <View style={{ flexDirection: columns ? "row" : "column", flexWrap: columns ? "wrap" : "nowrap", columnGap: SPACE.card, rowGap: SPACE.sm }}>
      {items.map((line) => (
        <View key={line} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm + SPACE.hair, ...(columns ? { flexBasis: "45%", minWidth: 240, flexGrow: 1, flexShrink: 1 } : {}) }}>
          {HostIcon ? <View style={{ paddingTop: SPACE.xs }}><HostIcon name={icon} size={16} color={theme.colors.accent} /></View> : <Text style={{ ...TYPE.body, color: theme.colors.accent }}>•</Text>}
          <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1 }}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A "Learn more" style toggle: a chevron and a label; the children show while
 * it is open. `quiet` draws it at secondary size in the muted colour, for
 * extras such as "What you can do here" that should not compete with the page.
 */
export function Disclosure({ theme, label, openLabel, initiallyOpen = false, quiet, children }: { theme: Theme; label: string; openLabel?: string; initiallyOpen?: boolean; quiet?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  const shown = open && openLabel ? openLabel : label;
  const color = quiet ? theme.colors.foregroundMuted : theme.colors.accent;
  return (
    <View style={{ gap: quiet ? SPACE.sm : SPACE.row }}>
      <Pressable accessibilityRole="button" accessibilityLabel={shown} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs, paddingVertical: SPACE.xs, alignSelf: "flex-start" }}>
        {HostIcon ? <HostIcon name={open ? "ChevronDown" : "ChevronRight"} size={quiet ? 14 : 16} color={color} /> : null}
        <Text style={{ ...(quiet ? TYPE.secondary : TYPE.body), color, fontWeight: "600" }}>{shown}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/**
 * A card of fold-out rows (0.11.0, from paseo-mcp 0.19.0's `client/ui.tsx`):
 * the technical or less-used parts of a tab sit here, each one press away,
 * so the tab itself stays plain. Children are AccordionItems (null ones are
 * skipped); the card draws the rule between them.
 */
export function Accordion({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderRadius: RADIUS.card, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden", marginBottom: SPACE.section }}>
      {items.map((child, index) => (
        <View key={index} style={index > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.border } : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** One row of an Accordion: an icon, a title, a one-line summary and a chevron; its content opens below it. */
export function AccordionItem({ theme, compact, icon, title, summary, tone, open: initial = false, children }: {
  theme: Theme;
  compact?: boolean;
  icon?: string;
  title: string;
  /** One line under the title, so the row says what's inside before it's opened. */
  summary?: string;
  tone?: Tone;
  open?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  const pad = compact ? SPACE.md : SPACE.card;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        // react-native-web 0.21 ignores accessibilityState; say it the web way too.
        {...({ "aria-expanded": open } as object)}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: SPACE.row, paddingHorizontal: pad, paddingVertical: SPACE.row + SPACE.hair, minHeight: 56, opacity: pressed ? 0.7 : 1 })}
      >
        {icon ? <IconBadge theme={theme} name={icon} tone={tone && tone !== "neutral" ? tone : "accent"} size={32} /> : null}
        <View style={{ flex: 1, gap: SPACE.hair, minWidth: 0 }}>
          <Text style={{ ...TYPE.item, color: tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground }}>{title}</Text>
          {summary ? <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted }} numberOfLines={2}>{summary}</Text> : null}
        </View>
        {HostIcon ? (
          <HostIcon name={open ? "ChevronUp" : "ChevronDown"} size={18} color={theme.colors.foregroundMuted} />
        ) : (
          <Text style={{ ...TYPE.body, color: theme.colors.foregroundMuted }}>{open ? "▴" : "▾"}</Text>
        )}
      </Pressable>
      {open ? <View style={{ paddingHorizontal: pad, paddingBottom: pad, gap: SPACE.row }}>{children}</View> : null}
    </View>
  );
}

/** A heading inside a card, for one part of a longer explanation. */
export function SectionTitle({ theme, icon, children }: { theme: Theme; icon?: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
      {icon && HostIcon ? <HostIcon name={icon} size={18} color={theme.colors.accent} /> : null}
      <Text accessibilityRole="header" style={{ ...TYPE.section, color: theme.colors.foreground }}>{children}</Text>
    </View>
  );
}

/**
 * One muted line with an icon and an optional link, outside any card: for
 * things worth knowing but not worth a box (a sister plugin, where the
 * advanced settings live).
 */
export function QuietLine({ theme, icon, children, links }: { theme: Theme; icon?: string; children: React.ReactNode; links?: ReadonlyArray<{ label: string; onPress: () => void; accessibilityLabel?: string }> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm, marginBottom: SPACE.section }}>
      {icon && HostIcon ? <View style={{ paddingTop: SPACE.hair }}><HostIcon name={icon} size={16} color={theme.colors.foregroundMuted} /></View> : null}
      <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: SPACE.row, rowGap: SPACE.xs }}>
        <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{children}</Text>
        {(links ?? []).map((link) => (
          <Pressable key={link.label} accessibilityRole="link" accessibilityLabel={link.accessibilityLabel ?? link.label} onPress={link.onPress}>
            <Text style={{ ...TYPE.secondary, color: theme.colors.accent, fontWeight: "600" }}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A small coloured dot, for a status next to a name. */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** A reply to a button press, just under the tabs: an icon and the sentence, on a soft fill of its tone. */
export function MessageBar({ theme, tone, text }: { theme: Theme; tone: Tone; text: string }) {
  const color = tone === "neutral" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm + SPACE.hair, padding: SPACE.row, borderRadius: RADIUS.control, marginBottom: SPACE.section, backgroundColor: tint(color, 0.08) ?? theme.colors.surface1, borderWidth: 1, borderColor: tint(color, 0.3) ?? theme.colors.border }}>
      {HostIcon ? <View style={{ paddingTop: SPACE.xs }}><HostIcon name={BANNER_ICON[tone]} size={16} color={color} /></View> : null}
      <Text style={{ ...TYPE.body, color: tone === "neutral" ? theme.colors.foreground : color, flex: 1 }}>{text}</Text>
    </View>
  );
}
