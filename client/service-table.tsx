import React, { useState } from "react";
import { View } from "react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ProcessRow } from "../shared/processes";
import type { WorkspaceUsage } from "../shared/disk";
import { serviceInventory, serviceTableRows, type ServiceSort, type ServiceFilter } from "../shared/service-inventory";
import { nextResourceSort, type ResourceSort } from "../shared/resource-table";
import type { Process } from "./rpc";
import { formatBytes, formatPercent } from "./ui";
import { ProcessActions, type RowActions } from "./surface";
import { OpenChatButton } from "./ask";
import { Button, Card, Disclosure, ItemTitle, Meta, Row, SPACE } from "./kit";
import { ResourceCells, ResourceHeader, ResourceTable, ResourceToolbar, type ResourceColumn } from "./resource-table";

const FILTERS: readonly { value: ServiceFilter; label: string }[] = [
  { value: "all", label: "All apps" }, { value: "can-stop", label: "Can stop" }, { value: "no-workspace", label: "No workspace" },
];

const COLUMNS: readonly ResourceColumn[] = [
  { id: "workspace", label: "Workspace", weight: 2, sortable: true },
  { id: "project", label: "Project", weight: 1.2, sortable: true, compactInline: true },
  { id: "app", label: "App", weight: 1.4, sortable: true, compactInline: true },
  { id: "ports", label: "Ports", weight: 0.7, sortable: true, compactInline: true },
  { id: "memory", label: "Memory", weight: 1.1, sortable: true, compactInline: true, numeric: true },
  { id: "cpu", label: "CPU", weight: 0.8, sortable: true, compactInline: true, numeric: true },
  { id: "status", label: "Status", weight: 1.7, sortable: true, compactInline: true },
  { id: "actions", label: "Open / Stop", width: 216 },
];

/** The live inventory is independent of disk measurements and keeps ownership beside each app. */
export function ServiceTable({ theme, compact, services, processes = [], workspaces = [], actions, renderOpen, loading, failed }: {
  theme: PluginTheme; compact: boolean; services: readonly Process[]; processes?: readonly ProcessRow[]; workspaces?: readonly WorkspaceUsage[];
  actions: RowActions; renderOpen(service: Process): React.ReactNode; loading?: boolean; failed?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ServiceFilter>("all");
  const [sort, setSort] = useState<ResourceSort<ServiceSort>>({ id: "memory", direction: "desc" });
  const rows = serviceTableRows(serviceInventory(services, processes, workspaces), search, sort, filter);
  const reset = () => { setSearch(""); setFilter("all"); };
  return <Card theme={theme} title={`Running apps · ${services.length}`} icon="Server" flush>
    <Meta theme={theme}>Up to 50 listening apps · Memory descending by default.</Meta>
    <Disclosure theme={theme} label="Details" quiet><Meta theme={theme}>CPU is a share of one core. A listening port does not prove the app is healthy. Running apps appear without a disk check; disk measurements run separately when requested.</Meta></Disclosure>
    <ResourceToolbar theme={theme} label="Search apps, workspaces, projects or ports" search={search} onSearch={setSearch}>
      <Row>
        <View style={{ flexGrow: 1, flexBasis: 240, minWidth: 0, maxWidth: "100%" }}><SettingsSelect<ServiceFilter> label="App filter" value={filter} options={FILTERS} onValueChange={setFilter} /></View>
        <Meta theme={theme}>{`${rows.length} of ${services.length} apps in this snapshot`}</Meta>
        {search || filter !== "all" ? <Button theme={theme} label="Reset" accessibilityLabel="Clear app search and filter" onPress={reset} /> : null}
      </Row>
    </ResourceToolbar>
    <ResourceTable theme={theme} compact={compact} header={(narrow) => <ResourceHeader theme={theme} columns={COLUMNS} compact={narrow} sort={sort} onSort={(id) => setSort(nextResourceSort(sort, id as ServiceSort))} />}>{(narrow) => <>
      {rows.map(({ service, workspace, project, ownership, chatId, status }) => <View key={`${service.pid}:${service.name}`} style={{ borderBottomWidth: 1, borderColor: theme.colors.border, paddingVertical: SPACE.row, minWidth: 0 }}>
        <ResourceCells theme={theme} columns={COLUMNS} compact={narrow} cells={{
          workspace: <View style={{ gap: SPACE.xs, minWidth: 0 }}><ItemTitle theme={theme}>{workspace}</ItemTitle><Meta theme={theme}>{ownership}</Meta>{chatId ? <Row><OpenChatButton theme={theme} agentId={chatId} /></Row> : null}</View>,
          project: <Meta theme={theme}>{project}</Meta>,
          app: <View><ItemTitle theme={theme}>{service.classification.label}</ItemTitle><Meta theme={theme}>{`${service.name} · PID ${service.pid}`}</Meta></View>,
          ports: <Meta theme={theme}>{service.ports.length ? service.ports.map((port) => `:${port}`).join(" ") : "Not listening yet"}</Meta>,
          memory: <Meta theme={theme}>{formatBytes(service.rssBytes)}</Meta>,
          cpu: <Meta theme={theme}>{service.cpuPercent === null ? "Sampling…" : formatPercent(service.cpuPercent, 1)}</Meta>,
          status: <Meta theme={theme}>{status}</Meta>,
          actions: <View style={{ gap: SPACE.sm, minWidth: 0 }}>{renderOpen(service)}<ProcessActions process={service} actions={actions} /></View>,
        }} />
      </View>)}
    </>}</ResourceTable>
    {loading ? <Meta theme={theme}>Checking this computer's running apps…</Meta> : failed ? <Meta theme={theme}>The running-app inventory could not be read. Refresh to try again.</Meta> : !services.length ? <Meta theme={theme}>No running apps were found in the current listener snapshot. Start your app's dev command in a Paseo workspace, then Refresh. No disk check is needed.</Meta> : !rows.length ? <Meta theme={theme}>No apps match this search and filter. Use Reset to clear both and see this snapshot's running apps.</Meta> : null}
  </Card>;
}
