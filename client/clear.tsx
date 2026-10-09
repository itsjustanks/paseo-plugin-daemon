import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { diskClear, diskPreview, formatSize, isBigDelete, type DiskJob, type DiskPlan } from "../shared/disk";
import { redactSecrets } from "../shared/redaction";
import { CancelButton, DangerLine, DestructiveButton, Sheet, UnderstandBox, errorText, useOnce } from "./feedback";
import { ItemTitle, Meta, Note, SPACE, TYPE } from "./kit";

/**
 * The warning before one-press Clear deletes anything (0.16.0). It opens on a
 * fresh check of every folder (nothing in use, nothing changed since the
 * scan) and lists exactly what goes, by workspace, with sizes, and what
 * won't and why. The red button says how much it deletes; Cancel is the
 * default and Enter never confirms. A big delete (over 10 GB or 20 folders)
 * needs "I understand" ticked first. It confirms once, and every opening
 * starts fresh. Paseo's dialog where the app has one; otherwise the same
 * warning in place, framed in red.
 */

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** One line per kind that will go, with how that kind comes back (final gate: not one line for all). */
export const comesBack = (items: DiskPlan["items"]) => {
  const byKind = new Map<string, string>();
  for (const item of items) if (item.ok) byKind.set(item.where.slice(item.where.lastIndexOf("/") + 1), item.cost);
  return [...byKind].map(([kind, cost]) => `${kind}: ${cost}`);
};
const checkedWords = (at: number, now = Date.now()) => { const seconds = Math.max(0, Math.round((now - at) / 1000)); return seconds < 45 ? "Checked just now" : `Checked ${Math.round(seconds / 60)} min ago`; };

export function DeleteDialog({ theme, tokens, open, onClose, onStarted }: {
  theme: PluginTheme;
  /** The Clear tokens of the folders the person picked. */
  tokens: readonly string[];
  open: boolean;
  onClose(): void;
  /** The job as it started; the caller follows it and says how it went. */
  onStarted(job: DiskJob): void;
}) {
  const preview = useRpc(diskPreview), clear = useRpc(diskClear);
  const [plan, setPlan] = useState<DiskPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [starting, setStarting] = useState(false);

  // Every opening starts from nothing and checks again; closing forgets it all.
  useEffect(() => {
    setPlan(null); setError(null); setUnderstood(false); setStarting(false);
    if (!open || !tokens.length) return;
    let live = true;
    preview({ tokens: [...tokens] }).then((next) => { if (live) setPlan(next); }).catch((reason: unknown) => { if (live) setError(errorText(reason, "The folders couldn't be checked. Try again.")); });
    return () => { live = false; };
  }, [open]);

  const okTokens = plan ? tokens.filter((_token, index) => plan.items[index]?.ok) : [];
  const big = plan ? isBigDelete(plan.bytes, plan.count) : false;
  const ready = !!plan && plan.count > 0 && (!big || understood) && !starting;
  const confirm = useOnce(open, () => {
    if (!ready) return;
    setStarting(true);
    clear({ tokens: okTokens }).then((job) => { onStarted(job); onClose(); }).catch((reason: unknown) => { setError(errorText(reason, "Deleting couldn't start. Nothing was deleted.")); setStarting(false); });
  });

  const title = !plan ? "Delete folders?" : plan.count ? `Delete ${plural(plan.count, "folder")} (${formatSize(plan.bytes)})?` : "Nothing can be deleted right now";
  const groups = new Map<string, DiskPlan["items"]>();
  for (const item of plan?.items.filter((entry) => entry.ok) ?? []) groups.set(item.workspace, [...(groups.get(item.workspace) ?? []), item]);
  const refused = plan?.items.filter((entry) => !entry.ok) ?? [];

  return (
    <Sheet title={title} open={open} busy={starting} onClose={onClose} colors={{ surface: theme.colors.surface1, border: theme.colors.statusDanger, foreground: theme.colors.foreground }}>
      <View style={{ gap: SPACE.row, padding: SPACE.card, maxWidth: 640 }}>
        {!plan && !error ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>Checking each folder again: nothing in use, nothing changed…</Text>
          </View>
        ) : null}
        {error ? <Note theme={theme} tone="danger">{error}</Note> : null}
        {plan && plan.count > 0 ? (
          <>
            <DangerLine theme={theme}>This permanently deletes these folders. They can't be restored from Paseo.</DangerLine>
            <View style={{ gap: SPACE.xs }}>
              <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>How they come back:</Text>
              {comesBack(plan.items).map((line) => <Meta key={line} theme={theme}>{line}</Meta>)}
            </View>
            {[...groups].map(([workspace, items]) => (
              <View key={workspace} style={{ gap: SPACE.xs }}>
                <ItemTitle theme={theme}>{redactSecrets(workspace)}</ItemTitle>
                {items.map((item, index) => <Meta key={`${item.path}-${index}`} theme={theme}>{`${item.where} · ${formatSize(item.bytes)} · ${item.what}`}</Meta>)}
              </View>
            ))}
          </>
        ) : null}
        {refused.length ? (
          <View style={{ gap: SPACE.xs }}>
            <ItemTitle theme={theme}>{plan?.count ? "Won't be deleted" : "Why not"}</ItemTitle>
            {refused.map((item, index) => <Meta key={`no-${item.path}-${index}`} theme={theme}>{`${item.workspace ? `${item.workspace} · ` : ""}${item.where}: ${item.reason ?? "Not deleted."}`}</Meta>)}
          </View>
        ) : null}
        {plan ? <Meta theme={theme}>{checkedWords(plan.checkedAt)}</Meta> : null}
        {big ? <UnderstandBox theme={theme} checked={understood} onChange={setUnderstood} label="I understand these will be deleted" /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: SPACE.sm }}>
          <CancelButton theme={theme} label={plan && !plan.count ? "Close" : "Cancel"} onPress={onClose} disabled={starting} accessibilityLabel={`Cancel: ${title}`} />
          {plan && plan.count > 0 ? <DestructiveButton theme={theme} label={`Delete ${formatSize(plan.bytes)}`} busy={starting} disabled={!ready} onPress={confirm} /> : null}
        </View>
      </View>
    </Sheet>
  );
}

/** What the last clear did, for one workspace's row: deleted, or skipped and why. */
export function ClearResults({ theme, job, workspace }: { theme: PluginTheme; job: DiskJob | null; workspace: string }) {
  const results = (job?.results ?? []).filter((result) => result.workspace === workspace);
  if (!results.length) return null;
  return (
    <View style={{ gap: SPACE.xs }}>
      <ItemTitle theme={theme}>Last clear</ItemTitle>
      {results.map((result, index) => (
        <Meta key={`${result.where}-${index}`} theme={theme}>{result.ok ? `Deleted ${result.where} (${formatSize(result.bytes)})` : `Skipped ${result.where || "a folder"}: ${result.message}`}</Meta>
      ))}
    </View>
  );
}
