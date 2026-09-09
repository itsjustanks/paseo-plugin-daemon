import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { createContext, useContext, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

/**
 * Monitor's design language, derived entirely from the six Paseo theme tokens.
 *
 * Rules that keep it honest:
 *   - every Text takes foreground or foregroundMuted; status colours only ever
 *     sit next to a word or an icon, never on a bare number;
 *   - one accent-filled control per view (the selected segment);
 *   - a 1px border marks structure (card edge, row divider) and nothing else;
 *   - 4/8px rhythm, tabular figures on every numeric value.
 */

// ------------------------------------------------------------------- colour

function parse(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1]!;
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16);
    if (value.length === 3 || value.length === 4) {
      return [expand(value[0]!), expand(value[1]!), expand(value[2]!), value.length === 4 ? expand(value[3]!) / 255 : 1];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return [parts[0]!, parts[1]!, parts[2]!, Number.isFinite(parts[3]!) ? parts[3]! : 1];
    }
  }
  return null;
}

/** Translucent version of a colour; unparseable input is returned unchanged. */
export function alpha(color: string, amount: number): string {
  const parsed = parse(color);
  if (!parsed) return color;
  const [r, g, b, a] = parsed;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, a * amount))})`;
}

// -------------------------------------------------------------------- tokens

export type Tokens = ReturnType<typeof tokens>;

export function tokens(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    compact,
    color: {
      fg: colors.foreground,
      muted: colors.foregroundMuted,
      accent: colors.accent,
      accentFg: colors.accentForeground,
      success: colors.statusSuccess,
      warning: colors.statusWarning,
      danger: colors.statusDanger,
      surface0: colors.surface0,
      surface1: colors.surface1,
      surface2: colors.surface2,
      border: colors.border,
      borderSubtle: alpha(colors.border, 0.6),
      track: alpha(colors.foregroundMuted, 0.18),
      disabled: alpha(colors.foreground, 0.38),
    },
    text: {
      title: { fontSize: 18, fontWeight: "700" as const, lineHeight: 24, color: colors.foreground },
      heading: { fontSize: 14, fontWeight: "600" as const, lineHeight: 20, color: colors.foreground },
      body: { fontSize: compact ? 14 : 13, fontWeight: "400" as const, lineHeight: compact ? 20 : 18, color: colors.foreground },
      bodyStrong: { fontSize: compact ? 14 : 13, fontWeight: "600" as const, lineHeight: compact ? 20 : 18, color: colors.foreground },
      label: { fontSize: 12, fontWeight: "500" as const, lineHeight: 16, color: colors.foregroundMuted },
      caption: { fontSize: compact ? 12 : 11, fontWeight: "400" as const, lineHeight: 16, color: colors.foregroundMuted },
      value: {
        fontSize: compact ? 26 : 28,
        fontWeight: "600" as const,
        lineHeight: compact ? 30 : 32,
        color: colors.foreground,
        fontVariant: ["tabular-nums" as const],
      },
      figure: {
        fontSize: compact ? 13 : 12,
        fontWeight: "500" as const,
        lineHeight: 16,
        color: colors.foreground,
        fontVariant: ["tabular-nums" as const],
      },
      mono: {
        fontSize: compact ? 12 : 11,
        lineHeight: 16,
        color: colors.foregroundMuted,
        fontFamily: compact ? "monospace" : "Menlo",
      },
    },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radius: { sm: 6, md: 10, pill: 999 },
    control: { min: compact ? 40 : 30, hit: { top: 6, bottom: 6, left: 6, right: 6 } },
    /** Wide content stays readable; nothing stretches edge to edge on a monitor. */
    maxWidth: 1080,
  };
}

const TokensContext = createContext<Tokens | null>(null);

export function TokensProvider({ value, children }: { value: Tokens; children: React.ReactNode }) {
  return <TokensContext.Provider value={value}>{children}</TokensContext.Provider>;
}

export function useTokens(): Tokens {
  const value = useContext(TokensContext);
  if (!value) throw new Error("useTokens must be used inside TokensProvider");
  return value;
}

export function useUi(theme: PluginTheme, compact: boolean): Tokens {
  return useMemo(() => tokens(theme, compact), [theme, compact]);
}

// ---------------------------------------------------------------- status map

export type Tone = "ok" | "warning" | "danger" | "neutral" | "accent";

export function toneColor(t: Tokens, tone: Tone): string {
  if (tone === "ok") return t.color.success;
  if (tone === "warning") return t.color.warning;
  if (tone === "danger") return t.color.danger;
  if (tone === "accent") return t.color.accent;
  return t.color.muted;
}

// ----------------------------------------------------------------- structure

export function Card({ children, tone, padded = true }: { children: React.ReactNode; tone?: Tone; padded?: boolean }) {
  const t = useTokens();
  return (
    <View
      style={{
        backgroundColor: t.color.surface1,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: tone ? alpha(toneColor(t, tone), 0.45) : t.color.border,
        padding: padded ? (t.compact ? t.space.md : t.space.lg) : 0,
        gap: t.space.sm,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

export function Section({ title, trailing, children }: { title: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm, minHeight: 20 }}>
        <Text style={t.text.heading}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** Fixed-width cards that wrap on wide layouts and stack in compact ones. */
export function Grid({ children, min = 240 }: { children: React.ReactNode; min?: number }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: t.compact ? "column" : "row", flexWrap: t.compact ? "nowrap" : "wrap", alignItems: "stretch", gap: t.space.md }}>
      {React.Children.map(children, (child) =>
        child ? <View style={{ width: t.compact ? "100%" : undefined, flexGrow: 1, flexBasis: t.compact ? undefined : min, minWidth: t.compact ? undefined : min }}>{child}</View> : null,
      )}
    </View>
  );
}

// ------------------------------------------------------------------- atoms

/** A dot and a word, always both; colour is never the only channel. */
export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  const t = useTokens();
  const color = toneColor(t, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }} accessibilityLabel={label}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={[t.text.caption, { color: tone === "neutral" ? t.color.muted : t.color.fg, fontWeight: "600" }]}>{label}</Text>
    </View>
  );
}

export function Tag({ label, tone }: { label: string; tone?: Tone }) {
  const t = useTokens();
  const color = tone ? toneColor(t, tone) : t.color.muted;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: tone ? alpha(color, 0.16) : t.color.surface2,
        borderRadius: t.radius.sm,
        paddingVertical: 2,
        paddingHorizontal: 7,
      }}
    >
      <Text style={{ fontSize: 11, lineHeight: 15, fontWeight: "600", color: tone ? t.color.fg : t.color.muted }}>{label}</Text>
    </View>
  );
}

/** Short facts separated by dots. Values are neutral; only a `tone` fact gets colour. */
export function Facts({ items }: { items: Array<{ value: string; tone?: Tone } | null | undefined | false> }) {
  const t = useTokens();
  const list = items.filter(Boolean) as Array<{ value: string; tone?: Tone }>;
  if (list.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {list.map((item, index) => (
        <React.Fragment key={`${item.value}-${index}`}>
          {index > 0 ? <Text style={[t.text.caption, { opacity: 0.5 }]}>·</Text> : null}
          <Text style={[t.text.caption, { fontVariant: ["tabular-nums"] }, item.tone ? { color: toneColor(t, item.tone) } : null]}>{item.value}</Text>
        </React.Fragment>
      ))}
    </View>
  );
}

/** Icon plus sentence. Used for warnings, notices and empty states. */
export function Notice({ icon, tone = "neutral", children, action }: { icon: string; tone?: Tone; children: React.ReactNode; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: t.compact ? "column" : "row",
        alignItems: t.compact ? "stretch" : "center",
        gap: t.space.sm,
        padding: t.space.md,
        borderRadius: t.radius.md,
        backgroundColor: tone === "neutral" ? t.color.surface1 : alpha(toneColor(t, tone), 0.12),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flex: 1 }}>
        <Icon name={icon} size={16} color={tone === "neutral" ? t.color.muted : toneColor(t, tone)} />
        <Text style={[t.text.body, { flex: 1 }]}>{children}</Text>
      </View>
      {action}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  icon,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  accessibilityLabel?: string;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  const palette = {
    primary: { bg: t.color.accent, border: t.color.accent, fg: t.color.accentFg },
    secondary: { bg: t.color.surface2, border: t.color.border, fg: t.color.fg },
    ghost: { bg: "transparent", border: "transparent", fg: t.color.fg },
    danger: { bg: alpha(t.color.danger, 0.14), border: alpha(t.color.danger, 0.45), fg: t.color.danger },
  }[variant];
  const fg = off ? t.color.disabled : palette.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      onPress={onPress}
      disabled={off}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        minHeight: t.control.min,
        paddingHorizontal: variant === "ghost" ? 8 : 12,
        borderRadius: t.radius.sm,
        borderWidth: 1,
        borderColor: off && variant !== "ghost" ? t.color.borderSubtle : palette.border,
        backgroundColor: off && variant === "primary" ? alpha(t.color.accent, 0.25) : palette.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Text style={{ fontSize: t.compact ? 13 : 12, fontWeight: "600", color: fg }}>{label}</Text>
    </Pressable>
  );
}

/** Icon-only control for the toolbar; label is spoken, not shown. */
export function IconButton({ icon, label, onPress, loading, disabled }: { icon: string; label: string; onPress: () => void; loading?: boolean; disabled?: boolean }) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      onPress={onPress}
      disabled={off}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        width: Math.max(t.control.min, 36),
        height: Math.max(t.control.min, 36),
        borderRadius: t.radius.sm,
        borderWidth: 1,
        borderColor: t.color.border,
        backgroundColor: pressed ? t.color.surface2 : t.color.surface1,
        alignItems: "center",
        justifyContent: "center",
        opacity: off ? 0.6 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={t.color.muted} /> : <Icon name={icon} size={16} color={t.color.fg} />}
    </Pressable>
  );
}

/** A destructive action asks once, in place, rather than through a dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  target,
  disabled,
  loading,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Spoken in the accessibility label so "Stop" is never ambiguous across rows. */
  target: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const t = useTokens();
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button
        label={label}
        variant="danger"
        disabled={disabled}
        loading={loading}
        accessibilityLabel={`${label} ${target}`}
        onPress={() => setArmed(true)}
      />
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: t.space.sm }}>
      <Button
        label={confirmLabel}
        variant="danger"
        accessibilityLabel={`Confirm: ${confirmLabel} ${target}`}
        onPress={() => {
          setArmed(false);
          onConfirm();
        }}
      />
      <Button label="Cancel" variant="ghost" accessibilityLabel={`Cancel stopping ${target}`} onPress={() => setArmed(false)} />
    </View>
  );
}

/** Segmented control: exactly one filled segment, the rest quiet. */
export function Segmented<Id extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ id: Id; label: string; badge?: string }>;
  value: Id;
  onChange: (id: Id) => void;
  label: string;
}) {
  const t = useTokens();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignSelf: t.compact ? "stretch" : "flex-start",
        backgroundColor: t.color.surface1,
        borderRadius: t.radius.sm + 2,
        borderWidth: 1,
        borderColor: t.color.border,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={`${option.label}${option.badge ? `, ${option.badge}` : ""}`}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.id)}
            hitSlop={t.control.hit}
            style={({ pressed }) => ({
              flex: t.compact ? 1 : undefined,
              minHeight: t.control.min - 4,
              paddingHorizontal: 12,
              borderRadius: t.radius.sm,
              backgroundColor: selected ? t.color.accent : pressed ? t.color.surface2 : "transparent",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            })}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: selected ? t.color.accentFg : t.color.muted }}>{option.label}</Text>
            {option.badge ? (
              <Text style={{ fontSize: 11, fontWeight: "600", color: selected ? t.color.accentFg : t.color.muted, fontVariant: ["tabular-nums"], opacity: 0.85 }}>
                {option.badge}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ charts

/**
 * Fixed 0–100 bar sparkline. The scale never rescales, so two charts side by
 * side compare honestly and a quiet machine stays visibly quiet. Null samples
 * render as an empty slot (gap) rather than a zero bar.
 */
export function Spark({ values, tone = "accent", height = 28, label }: { values: Array<number | null>; tone?: Tone; height?: number; label: string }) {
  const t = useTokens();
  const color = toneColor(t, tone);
  return (
    <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height, width: "100%" }}>
      {values.map((value, index) => {
        const bounded = value === null ? null : Math.max(0, Math.min(100, value));
        return (
          <View
            key={index}
            style={{
              flex: 1,
              height: bounded === null ? 2 : Math.max(2, Math.round((bounded / 100) * height)),
              borderRadius: 1,
              backgroundColor: bounded === null ? t.color.track : color,
              opacity: bounded === null ? 0.6 : 1,
            }}
          />
        );
      })}
    </View>
  );
}

/** Thin 0–100 meter under a figure. */
export function Meter({ percent, tone = "accent" }: { percent: number | null; tone?: Tone }) {
  const t = useTokens();
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <View style={{ height: 4, borderRadius: 2, backgroundColor: t.color.track, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(value)}%`, height: "100%", backgroundColor: percent === null ? t.color.track : toneColor(t, tone) }} />
    </View>
  );
}

// --------------------------------------------------------------- formatters

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

export function formatLoad(load: readonly [number, number, number]): string {
  return load.map((value) => value.toFixed(2)).join(" · ");
}
