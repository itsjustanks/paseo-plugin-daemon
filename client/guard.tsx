import { redactSecrets } from "../shared/redaction";
import { Confirm, errorText, hasDialog } from "./feedback";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { pluginRestart, pluginRestartStatus, type RestartOutcome } from "../shared/guard";
import type { HealthIssue } from "../shared/health";
import { processPreview, processReport, processStop, type StopPlan } from "../shared/processes";
import { Button, Disclosure, Meta, Note, Row, SPACE, TYPE, type Tone } from "./kit";
import { StopSheet, type Say } from "./processes";

type Theme = PluginTheme;

/**
 * 0.13.0's two one-press fixes, shared by Overview, Processes and the
 * sidebar dot's popover so they look and behave the same everywhere.
 *
 * Restart asks first (0.15.0: in Paseo's dialog on a page, in place inside
 * the popover): it says exactly what will happen and what won't, then runs.
 * Stop opens the same ask-first sheet as the Processes tab.
 */

const toneOf = (outcome: RestartOutcome): Tone => (outcome.ok ? "success" : outcome.outcome === "refused" || outcome.outcome === "running" ? "warning" : "danger");
const POLL_MS = 2000;
/** A wedged restart takes about two minutes; stop asking well after that. */
const POLL_LIMIT = 120;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Restart <plugin>" for a plugin-stuck issue, with its ask-first step. `say`
 * posts the result to the page's message bar; without it the result shows
 * here. Plain state, no query client: the sidebar popover has none.
 */
export function RestartPlugin({ theme, issue, say, onDone, inPlace }: { theme: Theme; issue: HealthIssue; say?: Say; onDone?: () => void; inPlace?: boolean }) {
  const restart = useRpc(pluginRestart);
  const status = useRpc(pluginRestartStatus);
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RestartOutcome | null>(null);
  const name = issue.subject ?? "this plugin";
  const run = () => {
    setAsking(false);
    setPending(true);
    const pluginId = issue.plugin!;
    // The first call answers within 20 seconds; a longer restart answers "running" and is followed here.
    const follow = async () => {
      let outcome = await restart({ pluginId });
      for (let polls = 0; outcome.outcome === "running" && polls < POLL_LIMIT; polls += 1) {
        setResult(outcome);
        await wait(POLL_MS);
        outcome = await status({ pluginId }).catch(() => outcome);
      }
      return outcome;
    };
    void follow()
      .then((outcome) => { setResult(outcome); say?.({ text: outcome.message, tone: toneOf(outcome) }); onDone?.(); })
      .catch((error: unknown) => { const text = errorText(error); setResult({ ok: false, outcome: "failed", message: text, steps: [] }); say?.({ text, tone: "danger" }); })
      .finally(() => { setPending(false); });
  };
  if (!issue.plugin) return null;
  if (issue.restartable === false) return <Meta theme={theme}>{issue.restartReason ?? "Restart isn't available on this host."}</Meta>;
  // 0.15.0: the ask is Paseo's dialog on a page (in place inside the sidebar popover), single use, so a double press restarts once.
  return (
    <View style={{ gap: SPACE.sm }}>
      {pending ? (
        <Note theme={theme}>{`Restarting ${name}… It can take up to a minute.`}</Note>
      ) : !(asking && (inPlace || !hasDialog())) ? (
        <Row><Button theme={theme} label={`Restart ${name}…`} icon="RotateCw" accessibilityLabel={`Restart ${name}. Asks first.`} onPress={() => { setResult(null); setAsking(true); }} /></Row>
      ) : null}
      <Confirm theme={theme} open={asking && !pending} inPlace={inPlace} title={`Restart ${name}?`} confirmLabel={`Restart ${name}`}
        text={`Hosts asks Paseo to reload ${name}. If Paseo's plugin manager is stuck on it, Hosts then stops only ${name}'s own process and reloads it. Paseo itself, your agents and the other plugins keep running. It can take up to a minute.`}
        onConfirm={run} onCancel={() => setAsking(false)} />
      {result && (!say || result.outcome === "running") ? <Note theme={theme} tone={toneOf(result)}>{result.message}</Note> : null}
      {result?.steps.length ? (
        <Disclosure theme={theme} label="What Hosts did" quiet>
          {result.steps.map((step, index) => <Meta key={index} theme={theme}>{`${new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${step.text}`}</Meta>)}
        </Disclosure>
      ) : null}
    </View>
  );
}

/** "Stop…" for one process by PID: finds its current signed handle, shows the ask-first sheet, then stops it. */
export function StopProcess({ theme, pid, say, onDone }: { theme: Theme; pid: number; say: Say; onDone?: () => void }) {
  const report = useRpc(processReport), preview = useRpc(processPreview), stop = useRpc(processStop);
  const [plan, setPlan] = useState<StopPlan | null>(null);
  const [tokens, setTokens] = useState<string[]>([]);
  const ask = useMutation({
    mutationFn: async () => {
      const found = await report({ query: String(pid), filter: "stoppable", sort: "memory", limit: 10, offset: 0 });
      const row = found.processes.find((item) => item.pid === pid && item.actionToken);
      if (!row) throw new Error("It has already stopped, or it can no longer be stopped here.");
      setTokens([row.actionToken!]);
      return preview({ tokens: [row.actionToken!] });
    },
    onSuccess: setPlan,
    onError: (error) => say({ text: errorText(error), tone: "warning" }),
  });
  const confirm = useMutation({
    mutationFn: () => stop({ tokens }),
    onSuccess: (outcome) => {
      setPlan(null);
      const failed = outcome.results.filter((item) => !item.ok);
      say({ text: outcome.results.map((item) => (item.ok ? item.message : `${item.name}: ${item.message}`)).join(" "), tone: failed.length ? "danger" : "success" });
      onDone?.();
    },
    onError: (error) => { setPlan(null); say({ text: errorText(error), tone: "danger" }); },
  });
  return (
    <>
      <Button theme={theme} label="Stop…" icon="OctagonX" danger busy={ask.isPending} accessibilityLabel={`Stop PID ${pid}. Asks first.`} onPress={() => ask.mutate()} />
      <StopSheet theme={theme} plan={plan} busy={confirm.isPending} onCancel={() => setPlan(null)} onConfirm={() => confirm.mutate()} />
    </>
  );
}

/** Stuck plugins as a short list: what's wrong and Restart, for the Processes tab. */
export function StuckPlugins({ theme, issues, say, onDone }: { theme: Theme; issues: readonly HealthIssue[]; say: Say; onDone?: () => void }) {
  const stuck = issues.filter((issue) => issue.code === "plugin-stuck");
  if (!stuck.length) return null;
  return (
    <View style={{ gap: SPACE.row }}>
      {stuck.map((issue) => (
        <View key={issue.plugin ?? issue.message} style={{ gap: SPACE.sm }}>
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{redactSecrets(issue.message)}</Text>
          <RestartPlugin theme={theme} issue={issue} say={say} onDone={onDone} />
        </View>
      ))}
    </View>
  );
}
