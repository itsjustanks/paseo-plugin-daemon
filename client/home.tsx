import React from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { HealthVerdict } from "../shared/health";
import type { ProcessReport } from "../shared/processes";
import { hostsSettings } from "../shared/settings";
import { seconds, watchId, watchSuggestions, type WatchResult } from "../shared/watch";
import type { Fold, TabId } from "../shared/tabs";
import { formatMinutes } from "../shared/tunnel-lease";
import { Checks, type SetupCheck } from "./guide";
import { Accordion, AccordionItem, Button, Dot, Fact, HeroCard, HostIcon, Meta, QuietLine, Row, SPACE, StatusLine, TYPE, toneColor, type Tone } from "./kit";
import { memoryWords, shareTone, type Say } from "./processes";
import { formatBytes } from "./ui";

type Theme = PluginTheme;
type Go = (tab: TabId, fold?: Fold) => void;

const WATCH_TONE: Record<WatchResult["state"], Tone> = { up: "success", slow: "warning", down: "danger", unknown: "neutral" };
const PROCESS_CODES = new Set(["memory-pressure", "cpu-pressure", "too-many-jobs", "runaway", "pressure-driver", "process-zombie"]);

/** The hero's words: the state first, in plain English, saying each thing once. */
export function heroState(verdict: HealthVerdict | undefined, setupDone: boolean): { tone: Tone; icon: string; title: string; lead: string | null } {
  if (!verdict) return { tone: "neutral", icon: "Loader", title: "Checking this host…", lead: "Measuring memory, CPU and running jobs. This takes a moment." };
  const unreachable = verdict.issues.find((issue) => issue.code === "host-unreachable");
  if (unreachable) return { tone: "danger", icon: "CircleAlert", title: "This host can't be read right now", lead: unreachable.message };
  const issues = verdict.issues.filter((issue) => issue.code !== "projects-unavailable");
  if (issues.length) {
    const critical = issues.some((issue) => issue.severity === "critical");
    const more = issues.length > 1 ? ` Plus ${issues.length - 1} more: see the rows below and Processes.` : "";
    return { tone: critical ? "danger" : "warning", icon: critical ? "CircleAlert" : "TriangleAlert", title: issues.length === 1 ? "Something needs attention" : `${issues.length} things need attention`, lead: `${issues[0]!.message}${more}` };
  }
  if (!setupDone) return { tone: "neutral", icon: "ListChecks", title: "One step left: let Hosts read your projects", lead: "Load and processes are being watched. Open Hosts on this host once after the daemon starts, so dev servers and workspace names can be matched to your Paseo projects." };
  return { tone: "success", icon: "CircleCheck", title: "All good: this host is calm", lead: `Memory and CPU are comfortable${verdict.watched?.length ? " and your watched services answer" : ""}.` };
}

function WatchedList({ theme, watched }: { theme: Theme; watched: readonly WatchResult[] }) {
  return (
    <View style={{ gap: SPACE.sm }}>
      {watched.map((service) => (
        <View key={service.id} style={{ gap: SPACE.hair }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Dot color={service.state === "up" ? theme.colors.statusSuccess : toneColor(theme, WATCH_TONE[service.state])} />
            <Text style={{ ...TYPE.body, color: theme.colors.foreground, flexShrink: 1 }}>{service.state === "up" && service.latencyMs !== null ? `${service.name} answered in ${seconds(service.latencyMs)}` : service.message}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SPACE.hair, height: 16, paddingLeft: SPACE.md }} accessibilityLabel={`${service.name}: last ${service.history.length} checks`}>
            {service.history.map((entry, index) => (
              <View key={index} style={{ width: 4, height: entry.state === "up" ? 8 : 16, borderRadius: 1, backgroundColor: entry.state === "up" ? theme.colors.statusSuccess : toneColor(theme, WATCH_TONE[entry.state]) }} />
            ))}
          </View>
          <Meta theme={theme}>{[service.target, service.usualMs !== null ? `usually ${seconds(service.usualMs)}` : null, service.checkedAt ? `checked ${new Date(service.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : null].filter(Boolean).join(" · ")}</Meta>
        </View>
      ))}
    </View>
  );
}

/** One quiet line offering to watch the AI Router's OmniRoute, when that plugin is set up here. */
function WatchSuggestion({ theme, hostId, say }: { theme: Theme; hostId: string; say: Say }) {
  const call = useRpc(watchSuggestions);
  const settings = useSettings(hostsSettings);
  const query = useQuery({ queryKey: ["daemon-link", hostId, "watch-suggestions"], queryFn: () => call({}), staleTime: 60_000, retry: 0 });
  const add = useMutation({
    mutationFn: async (suggestion: { name: string; url: string }) => {
      if (settings.status !== "ready") throw new Error("Settings aren't loaded yet. Try again in a moment.");
      const current = settings.values.watchedServices;
      const id = watchId(suggestion.name, current.map((item) => item.id));
      if (!await settings.save({ ...settings.values, watchedServices: [...current, { id, name: suggestion.name, url: suggestion.url, expectedStatus: null }] }, settings.revision)) throw new Error(settings.saveError ?? "The setting couldn't be saved.");
    },
    onSuccess: () => { say({ text: "Watching OmniRoute. Its first answer shows here within a minute.", tone: "success" }); void query.refetch(); },
    onError: (error) => say({ text: error instanceof Error ? error.message : String(error), tone: "danger" }),
  });
  const suggestion = query.data?.suggestions[0];
  if (!suggestion || settings.status !== "ready") return null;
  return (
    <QuietLine theme={theme} icon="Route" links={[{ label: add.isPending ? "Adding…" : "Watch it", accessibilityLabel: "Watch the AI Router's OmniRoute", onPress: () => add.mutate(suggestion) }]}>
      {`Watch the AI Router's OmniRoute, so a slow or failing router shows up here. ${suggestion.why}`}
    </QuietLine>
  );
}

/** One word for how the watched services are doing, for the hero row and its fold-out. */
function watchedWords(watched: readonly WatchResult[]): { value: string; tone: Tone } {
  const slow = watched.filter((service) => service.state === "slow" || service.state === "down");
  if (slow.length) return { value: `${slow.map((service) => service.name).join(", ")} ${slow.length === 1 ? (slow[0]!.state === "down" ? "down" : "slow") : "need attention"}`, tone: slow.some((service) => service.state === "down") ? "danger" : "warning" };
  if (watched.every((service) => service.state === "up")) return { value: `All ${watched.length} answering`, tone: "success" };
  return { value: "Checking…", tone: "neutral" };
}

/** Overview's "Technical details": the schedule, limits and where things are written. */
function TechnicalDetails({ theme, verdict, report }: { theme: Theme; verdict: HealthVerdict | undefined; report: ProcessReport | undefined }) {
  const settings = useSettings(hostsSettings);
  const values = settings.status === "ready" ? settings.values : null;
  return (
    <>
      {values ? <Fact theme={theme} label="Checks every" value={`${values.snapshotIntervalSeconds} seconds${values.backgroundHealthChecks ? ", even with Paseo closed" : ", while Hosts is open"}`} /> : null}
      {values ? <Fact theme={theme} label="Heavy-job limit" value={`${values.maxHeavyJobs} at once`} /> : null}
      {values ? <Fact theme={theme} label="Browser links last" value={formatMinutes(values.tunnelMinutes)} /> : null}
      {report ? <Fact theme={theme} label="Memory measured" value={report.memoryBasis === "container" ? "against this container's limit" : "against the whole machine"} /> : null}
      {report ? <Fact theme={theme} label="Processes" value={`${report.total} running · Paseo uses ${formatBytes(report.paseoBytes)}`} /> : null}
      {verdict ? <Fact theme={theme} label="Last checked" value={new Date(verdict.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} /> : null}
      <Fact theme={theme} label="Stop log" value="$PASEO_HOME/daemon-link/actions.jsonl" />
      <Fact theme={theme} label="Summary for other plugins" value="$PASEO_HOME/daemon-link/host-summary.json" />
      <Meta theme={theme}>Change the schedule and limits under Settings → Hosts.</Meta>
    </>
  );
}

/**
 * Overview is live status and actions only: the hero says the state in
 * words, then at most four rows, the last stop, and two buttons. Watched
 * services, setup checks and technical details fold out below it (0.11.0);
 * the teaching moved to Help.
 */
export function OverviewTab({ theme, compact, hostId, verdict, report, devServers, liveLinks, setupDone, checks, go, say, onCheck, checking }: {
  theme: Theme; compact: boolean; hostId: string;
  verdict: HealthVerdict | undefined; report: ProcessReport | undefined;
  devServers: number; liveLinks: number; setupDone: boolean; checks: readonly SetupCheck[];
  go: Go; say: Say; onCheck(): void; checking: boolean;
}) {
  const hero = heroState(verdict, setupDone);
  const watched = verdict?.watched ?? [];
  const processIssue = verdict?.issues.some((issue) => PROCESS_CODES.has(issue.code)) ?? false;
  const memory = report ? memoryWords(report) : null;
  const jobs = report?.heavyJobs;
  const slow = watched.filter((service) => service.state === "slow" || service.state === "down");
  const watchedNow = watchedWords(watched);
  const pending = checks.filter((check) => check.state !== "ready" && check.state !== "optional").length;
  const last = report?.recentActions[0];
  const primary: "processes" | "servers" | "check" = processIssue ? "processes" : slow.length ? "check" : devServers ? "servers" : "processes";
  return (
    <>
      <HeroCard theme={theme} tone={hero.tone} icon={hero.icon} title={hero.title} lead={hero.lead ?? undefined}>
        <View style={{ gap: SPACE.xs }}>
          {memory ? <StatusLine theme={theme} label="Memory" value={`${formatBytes(memory.used)} of ${formatBytes(memory.limit)}`} tone={shareTone(memory.percent)} hint={report?.memoryBasis === "container" ? "this container's limit" : "whole machine"} action={{ label: "Processes", onPress: () => go("processes") }} /> : null}
          {jobs ? <StatusLine theme={theme} label="Heavy jobs" value={`${jobs.count} of ${jobs.limit}`} tone={jobs.count > jobs.limit ? "warning" : "success"} hint={jobs.count ? "builds, tests and dev servers" : null} /> : null}
          <StatusLine theme={theme} label="Dev servers" value={devServers ? `${devServers} running` : "None running"} tone={devServers ? "success" : "neutral"} hint={liveLinks ? `${liveLinks} browser link${liveLinks === 1 ? "" : "s"} open` : null} action={{ label: "Dev servers", onPress: () => go("servers") }} />
          {watched.length ? <StatusLine theme={theme} label="Watched services" value={watchedNow.value} tone={watchedNow.tone} /> : null}
        </View>
        {last ? (
          <Row>
            {HostIcon ? <HostIcon name="History" size={16} color={theme.colors.foregroundMuted} /> : null}
            <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{`Last stop: ${last.name}${last.pid ? ` (PID ${last.pid})` : ""} at ${new Date(last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</Text>
          </Row>
        ) : null}
        <Row>
          {primary === "servers" ? <Button theme={theme} label="Open dev servers" icon="Server" primary onPress={() => go("servers")} /> : null}
          <Button theme={theme} label={processIssue ? "Review processes" : "See processes"} icon="Cpu" primary={primary === "processes"} onPress={() => go("processes")} />
          {primary !== "servers" ? <Button theme={theme} label="Check again" icon="RefreshCw" primary={primary === "check"} busy={checking} onPress={onCheck} /> : null}
        </Row>
      </HeroCard>
      <Accordion theme={theme}>
        {watched.length ? (
          <AccordionItem theme={theme} compact={compact} icon="Activity" title="Watched services" summary={`${watched.length} watched · ${watchedNow.value.toLowerCase()}`} tone={watchedNow.tone === "success" ? undefined : watchedNow.tone} open={slow.length > 0}>
            <WatchedList theme={theme} watched={watched} />
            <Meta theme={theme}>Add or remove them under Settings → Hosts → Watched services.</Meta>
          </AccordionItem>
        ) : null}
        <AccordionItem key={setupDone ? "done" : "todo"} theme={theme} compact={compact} icon="ListChecks" title="Setup checks" summary={pending ? `${pending} still to do` : "Everything Hosts needs is in place"} open={!setupDone}>
          <Checks theme={theme} checks={checks} onRefresh={onCheck} />
        </AccordionItem>
        <AccordionItem theme={theme} compact={compact} icon="SlidersHorizontal" title="Technical details" summary="How often it checks, the limits, and where it writes">
          <TechnicalDetails theme={theme} verdict={verdict} report={report} />
        </AccordionItem>
      </Accordion>
      {!watched.some((service) => /\/api\/health\/ping$/.test(service.target)) ? <WatchSuggestion theme={theme} hostId={hostId} say={say} /> : null}
    </>
  );
}
