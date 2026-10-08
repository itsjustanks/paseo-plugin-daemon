import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TAB_IDS, resolveTab, tabTitle } from "../shared/tabs";

describe("Hosts tabs (0.11.0)", () => {
  it("has four tabs at most, in the order people come to do things", () => {
    expect(TAB_IDS).toEqual(["overview", "processes", "workspaces", "help"]);
    expect(TAB_IDS.length).toBeLessThanOrEqual(4);
  });

  it("opens the current tabs by id, and Overview for anything unknown or missing", () => {
    for (const id of TAB_IDS) expect(resolveTab(id)).toEqual({ tab: id, fold: null });
    expect(resolveTab(undefined)).toEqual({ tab: "overview", fold: null });
    expect(resolveTab(null)).toEqual({ tab: "overview", fold: null });
    expect(resolveTab("")).toEqual({ tab: "overview", fold: null });
    expect(resolveTab("nonsense")).toEqual({ tab: "overview", fold: null });
    expect(resolveTab(" Processes ")).toEqual({ tab: "processes", fold: null });
  });

  it("sends 0.8–0.10 tab ids where their content lives now", () => {
    expect(resolveTab("connect")).toEqual({ tab: "workspaces", fold: "private" });
    expect(resolveTab("sync")).toEqual({ tab: "overview", fold: "sync" });
    expect(resolveTab("health")).toEqual({ tab: "processes", fold: null });
    expect(resolveTab("ssh")).toEqual({ tab: "workspaces", fold: "ssh" });
    expect(resolveTab("guide")).toEqual({ tab: "help", fold: null });
  });

  it("names the header after the tab", () => {
    expect(tabTitle("overview")).toBe("Hosts");
    expect(tabTitle("workspaces")).toBe("Hosts · Workspaces");
    // 0.14.0: old links to Dev servers land on Workspaces.
    expect(resolveTab("servers")).toEqual({ tab: "workspaces", fold: null });
    expect(resolveTab("servers", "ssh")).toEqual({ tab: "workspaces", fold: "ssh" });
    expect(resolveTab("disk")).toEqual({ tab: "workspaces", fold: null });
  });

  it("honours `open` only on the tab its fold-out lives on", () => {
    expect(resolveTab("workspaces", "ssh")).toEqual({ tab: "workspaces", fold: "ssh" });
    expect(resolveTab("connect", "sync")).toEqual({ tab: "workspaces", fold: "private" });
    expect(resolveTab("overview", "sync")).toEqual({ tab: "overview", fold: "sync" });
    expect(resolveTab("workspaces", "bogus")).toEqual({ tab: "workspaces", fold: null });
    expect(resolveTab("processes", "ssh")).toEqual({ tab: "processes", fold: null });
  });

  it("every deep link in the client names a tab that resolves to itself", () => {
    const root = join(__dirname, "..");
    const sources = ["index.client.tsx", "client/quick.tsx"].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    const tabs = [...sources.matchAll(/tab: "([a-z-]+)"/g)].map((match) => match[1]!);
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) expect(resolveTab(tab).tab).toBe(tab);
  });
});
