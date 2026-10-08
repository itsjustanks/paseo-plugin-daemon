import React from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { askSubjectFor, type HealthVerdict } from "../shared/health";
import type { ProcessReport } from "../shared/processes";
import { hostsSettings } from "../shared/settings";
import { seconds, watchId, watchSuggestions, type WatchResult } from "../shared/watch";
import type { Fold, TabId } from "../shared/tabs";
import { formatMinutes } from "../shared/tunnel-lease";
import { Checks, type SetupCheck } from "./guide";
import { Accordion, AccordionItem, Button, Dot, Fact, HeroCard, HostIcon, Meta, QuietLine, Row, SPACE, StatusLine, TYPE, toneColor, type Tone } from "./kit";
import { memoryWords, shareTone, type Say } from "./processes";
import { formatBytes } from "./ui";
import { AskAgentButton } from "./ask";
import { RestartPlugin, StopProcess } from "./guard";
import { guardState } from "../shared/guard";
import { formatSize } from "../shared/disk";

type Theme = PluginTheme;
type Go = (tab: TabId, fold?: Fold) => void;

const WATCH_TONE: Record<WatchResult["state"], Tone> = { up: "success", slow: "warning", down: "danger", unknown: "neutral" };
const PROCESS_CODES = new Set(["memory-pressure", "cpu-pressure", "too-many-jobs", "runaway", "pressure-driver", "process-zombie", "auto-stopped"]);
/** 0.14.0: a full disk is fixed on Workspaces. */
const DISK_CODES = new Set(["disk-full"]);

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

/**
 * Each thing that's wrong, in its own words, with "Ask an agent" where an
 * agent can help (0.12.0): a runaway or a job loading the host, a dev server
 * that stopped, a watched service that is slow or down. 0.13.0 adds the
 * one-press fixes: Stop beside a runaway Hosts may stop, and Restart beside
 * a plugin that isn't answering (both ask first).
 */
function AttentionList({ theme, verdict, say, onDone }: { theme: Theme; verdict: HealthVerdict; say: Say; onDone(): void }) {
  const issues = verdict.issues.filter((issue) => issue.code !== "projects-unavailable");
  return (
    <View style={{ gap: SPACE.row }}>
      {issues.map((issue, index) => {
        const subject = askSubjectFor(issue, verdict.watched ?? []);
        return (
          <View key={`${issue.code}-${index}`} style={{ gap: SPACE.sm }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm }}>
              <View style={{ paddingTop: SPACE.sm }}><Dot color={toneColor(theme, issue.severity === "critical" ? "danger" : "warning")} /></View>
              <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1 }}>{issue.message}</Text>
            </View>
            {subject || (issue.code === "runaway" && issue.stoppable && issue.pid) ? (
              <View style={{ paddingLeft: SPACE.md }}>
                <Row>
                  {subject ? <AskAgentButton theme={theme} subject={subject} /> : null}
                  {issue.code === "runaway" && issue.stoppable && issue.pid ? <StopProcess theme={theme} pid={issue.pid} say={say} onDone={onDone} /> : null}
                </Row>
              </View>
            ) : null}
            {issue.code === "plugin-stuck" ? <View style={{ paddingLeft: SPACE.md }}><RestartPlugin theme={theme} issue={issue} say={say} onDone={onDone} /></View> : null}
          </View>
        );
      })}
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
function TechnicalDetails({ theme, hostId, verdict, report }: { theme: Theme; hostId: string; verdict: HealthVerdict | undefined; report: ProcessReport | undefined }) {
  const settings = useSettings(hostsSettings);
  const values = settings.status === "ready" ? settings.values : null;
  const readGuard = useRpc(guardState);
  // Older daemons have no such call; the two lines are then simply absent.
  const guard = useQuery({ queryKey: ["daemon-link", hostId, "guard"], queryFn: () => readGuard({}), staleTime: 30_000, retry: 0 });
  return (
    <>
      {values ? <Fact theme={theme} label="Checks every" value={`${values.snapshotIntervalSeconds} seconds${values.backgroundHealthChecks ? ", even with Paseo closed" : ", while Hosts is open"}`} /> : null}
      {values ? <Fact theme={theme} label="Heavy-job limit" value={`${values.maxHeavyJobs} at once`} /> : null}
      <Fact theme={theme} label="Disk checks" value="Free space every 10 seconds; folder sizes only when you ask (Workspaces)" />
      {values ? <Fact theme={theme} label="Browser links last" value={formatMinutes(values.tunnelMinutes)} /> : null}
      {report ? <Fact theme={theme} label="Memory measured" value={report.memoryBasis === "container" ? "against this container's limit" : "against the whole machine"} /> : null}
      {report ? <Fact theme={theme} label="Processes" value={`${report.total} running · Paseo uses ${formatBytes(report.paseoBytes)}`} /> : null}
      {guard.data ? <Fact theme={theme} label="Plugin health" value={guard.data.logReadable ? "Read from Paseo's own log every 10 seconds" : "Unknown: this Paseo's log can't be read here"} /> : null}
      {guard.data ? <Fact theme={theme} label="Memory guard" value={guard.data.autoGuard.enabled ? "On: stops the biggest job Hosts may stop after a minute of nearly full memory" : "Off (Settings → Hosts)"} /> : null}
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
export function OverviewTab({ theme, compact, hostId, verdict, report, devServers, liveLinks, setupDone, checks, go, say, sync }: {
  theme: Theme; compact: boolean; hostId: string;
  verdict: HealthVerdict | undefined; report: ProcessReport | undefined;
  devServers: number; liveLinks: number; setupDone: boolean; checks: readonly SetupCheck[];
  go: Go; say: Say;
  /** Project Sync's fold-out (0.12.1: it moved here from Dev servers). */
  sync?: React.ReactNode;
}) {
  const hero = heroState(verdict, setupDone);
  const queryClient = useQueryClient();
  const changed = () => { void queryClient.invalidateQueries({ queryKey: ["daemon-link", hostId] }); };
  const watched = verdict?.watched ?? [];
  const processIssue = verdict?.issues.some((issue) => PROCESS_CODES.has(issue.code)) ?? false;
  const memory = report ? memoryWords(report) : null;
  const jobs = report?.heavyJobs;
  const slow = watched.filter((service) => service.state === "slow" || service.state === "down");
  const watchedNow = watchedWords(watched);
  const pending = checks.filter((check) => check.state !== "ready" && check.state !== "optional").length;
  // A reload isn't a stop (0.13.0): "Last stop" names the last process actually signalled.
  const last = report?.recentActions.find((entry) => entry.action !== "plugin-reload" && entry.status === "signaled");
  // One way to refresh (0.12.1): the header's Refresh link, so the hero offers where to go, not "Check again".
  const diskIssue = verdict?.issues.some((issue) => DISK_CODES.has(issue.code)) ?? false;
  const primary: "processes" | "workspaces" = diskIssue && !processIssue ? "workspaces" : processIssue || !devServers ? "processes" : "workspaces";
  return (
    <>
      <HeroCard theme={theme} tone={hero.tone} icon={hero.icon} title={hero.title} lead={hero.lead ?? undefined}>
        <View style={{ gap: SPACE.xs }}>
          {memory ? <StatusLine theme={theme} label="Memory" value={`${formatBytes(memory.used)} of ${formatBytes(memory.limit)}`} tone={shareTone(memory.percent)} action={{ label: "Processes", onPress: () => go("processes") }} /> : null}
          {verdict?.disk ? <StatusLine theme={theme} label="Disk" value={`${formatSize(verdict.disk.freeBytes)} free`} tone={verdict.disk.level === "critical" ? "danger" : verdict.disk.level === "warning" ? "warning" : "success"} hint={`${Math.round(verdict.disk.percent)}% used`} action={{ label: "Workspaces", onPress: () => go("workspaces") }} /> : null}
          {/* 0.14.0: four rows at most; heavy jobs only when there are some. */}
          {jobs && (jobs.count > 0 || !verdict?.disk) ? <StatusLine theme={theme} label="Heavy jobs" value={`${jobs.count} of ${jobs.limit}`} tone={jobs.count > jobs.limit ? "warning" : "success"} hint={`builds, tests and dev servers running now; ${jobs.limit} at once is the limit`} /> : null}
          <StatusLine theme={theme} label="Dev servers" value={devServers ? `${devServers} running` : "None running"} tone={devServers ? "success" : "neutral"} hint={liveLinks ? `${liveLinks} browser link${liveLinks === 1 ? "" : "s"} open` : null} action={{ label: "Workspaces", onPress: () => go("workspaces") }} />
          {watched.length ? <StatusLine theme={theme} label="Watched services" value={watchedNow.value} tone={watchedNow.tone} /> : null}
        </View>
        {last ? (
          <Row>
            {HostIcon ? <HostIcon name="History" size={16} color={theme.colors.foregroundMuted} /> : null}
            <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, flexShrink: 1 }}>{`Last stop: ${last.name}${last.pid ? ` (PID ${last.pid})` : ""} at ${new Date(last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</Text>
          </Row>
        ) : null}
        <Row>
          {primary === "workspaces" ? <Button theme={theme} label={diskIssue ? "Free up space" : "Open workspaces"} icon={diskIssue ? "HardDrive" : "FolderTree"} primary onPress={() => go("workspaces")} /> : null}
          <Button theme={theme} label={processIssue ? "Review processes" : "See processes"} icon="Cpu" primary={primary === "processes"} onPress={() => go("processes")} />
        </Row>
      </HeroCard>
      <Accordion theme={theme}>
        {verdict && verdict.issues.some((issue) => issue.code !== "projects-unavailable") ? (
          <AccordionItem key={`attention-${verdict.issues.length}`} theme={theme} compact={compact} icon="TriangleAlert" tone={hero.tone === "danger" ? "danger" : "warning"} title="What needs attention" summary="Each problem, with a fix or an agent to ask" open>
            <AttentionList theme={theme} verdict={verdict} say={say} onDone={changed} />
          </AccordionItem>
        ) : null}
        {watched.length ? (
          <AccordionItem theme={theme} compact={compact} icon="Activity" title="Watched services" summary={`${watched.length} watched · ${watchedNow.value}`} tone={watchedNow.tone === "success" ? undefined : watchedNow.tone} open={slow.length > 0}>
            <WatchedList theme={theme} watched={watched} />
            <Meta theme={theme}>Add or remove them under Settings → Hosts → Watched services.</Meta>
          </AccordionItem>
        ) : null}
        <AccordionItem key={setupDone ? "done" : "todo"} theme={theme} compact={compact} icon="ListChecks" title="Setup checks" summary={pending ? `${pending} still to do` : "Everything Hosts needs is in place"} open={!setupDone}>
          <Checks theme={theme} checks={checks} />
        </AccordionItem>
        {sync}
        <AccordionItem theme={theme} compact={compact} icon="SlidersHorizontal" title="Technical details" summary="How often it checks, the limits, and where it writes">
          <TechnicalDetails theme={theme} hostId={hostId} verdict={verdict} report={report} />
        </AccordionItem>
      </Accordion>
      {!watched.some((service) => /\/api\/health\/ping$/.test(service.target)) ? <WatchSuggestion theme={theme} hostId={hostId} say={say} /> : null}
    </>
  );
}
