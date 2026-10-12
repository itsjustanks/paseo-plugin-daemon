/** Owned loopback validation only. Never registered in the production plugin. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { contributeManagedBrowser } from "../../server/managed-browser/register";
import { handleWorkspaceArchived } from "../../server/managed-browser/browser";
import { resolveBrowserRuntimeAssets, privateBrowserEnvironment } from "../../server/managed-browser/runtime-path";
import { resolveSupervisorPaths } from "../../server/managed-browser/supervisor-paths";

async function main() {
  const home = process.env.PASEO_HOME;
  if (!home || !home.includes(".browser-test/")) throw new Error("Fixture requires an owned .browser-test PASEO_HOME");
  const assets = resolveBrowserRuntimeAssets(home);
  const supervisor = spawn(assets.node, [assets.supervisor], { env: privateBrowserEnvironment(process.env), stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await readFile(resolveSupervisorPaths(home).endpoint); break; }
    catch { if (i > 100) throw new Error("Owned supervisor did not start"); await delay(50); }
  }
  const handlers = new Map<string, { contract: any; handler: any }>();
  const hooks = new Map<string, any>();
  const remove = contributeManagedBrowser({ registerSettings() {},
    handle(contract: any, handler: any) { handlers.set(contract.name, { contract, handler }); },
    before(name: string, hook: any) { hooks.set(name, hook); return () => {}; }, on() { return () => {}; },
  } as any);
  const context = { signal: new AbortController().signal, paseo: { workspaces: { ref: (id: string) => ({ refresh: async () => id === "ws-fixture" ? { id } : null }) } } };
  const events: unknown[] = [];
  const timings: { name: string; ms: number; bytes: number }[] = [];
  let agent: Client | null = null;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    try {
      if (request.method === "POST" && ["/rpc", "/agent"].includes(path)) {
        if (request.headers["x-hosts-fixture"] !== "owned-browser-test") throw new Error("Fixture header required");
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 1_048_576) throw new Error("Fixture request too large"); }
        const { name, input } = JSON.parse(body);
        const start = performance.now();
        let result;
        if (path === "/rpc") {
          const entry = handlers.get(name); if (!entry) throw new Error("Unknown fixture RPC");
          result = entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), context));
        } else {
          if (!agent) {
            const created = await hooks.get("agent.create")({ request: { config: { provider: "codex" }, env: {} } }, context);
            const launch = created.config.mcpServers?.["hosts-browser"];
            if (!launch) throw new Error("Browser MCP injection unavailable");
            await hooks.get("agent.session_open")({ request: { reason: "create", purpose: "interactive", workspaceId: "ws-fixture", agentId: "owned-fixture-agent", env: created.env } }, context);
            agent = new Client({ name: "hosts-owned-browser-test", version: "1" });
            await agent.connect(new StdioClientTransport({ command: launch.command, args: launch.args,
              env: { ...privateBrowserEnvironment(process.env), ...launch.env } as Record<string, string>, stderr: "pipe" }));
          }
          result = name === "list" ? await agent.listTools() : await agent.callTool({ name, arguments: input ?? {} });
        }
        const encoded = JSON.stringify(result);
        timings.push({ name, ms: performance.now() - start, bytes: Buffer.byteLength(encoded) });
        if (timings.length > 2000) timings.shift();
        response.writeHead(200, { "Content-Type": "application/json" }).end(encoded); return;
      }
      if (path === "/event") {
        const url = new URL(request.url!, "http://127.0.0.1");
        events.push(Object.fromEntries(url.searchParams)); if (events.length > 1000) events.shift();
        response.writeHead(204).end(); return;
      }
      if (path === "/events" || path === "/metrics") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(path === "/events" ? events : timings)); return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head>
        <title>Hosts input fixture${path === "/page-two" ? " · page two" : ""}</title>
        <style>body{margin:0;background:#f4f6f8;color:#182535;font:18px system-ui;min-height:2000px}h1{margin:28px 40px;font-size:28px}
        input{position:absolute;left:40px;top:120px;width:220px;height:36px;font:18px system-ui}button{position:absolute;left:300px;top:120px;width:150px;height:42px}
        a{position:absolute;left:40px;top:190px}#hover{position:absolute;left:40px;top:250px;width:200px;height:80px;background:#a4b4cb;padding:12px}#hover:hover{background:#74d4a0}
        #counter{position:absolute;left:300px;top:250px}#scroll{position:absolute;left:40px;top:1200px}</style></head><body>
        <h1>Hosts browser · ${path === "/page-two" ? "page two" : "input fixture"}</h1>
        <input aria-label="Fixture text" placeholder="Type here"><button>Record click</button><a href="/page-two">Next page</a>
        <div id="hover">Hover or touch here</div><div id="counter"></div><div id="scroll">Scrolled down</div>
        <script>let n=0;setInterval(()=>document.querySelector('#counter').textContent='Frame '+(++n),100);
        for(const type of ['mousedown','mouseup','click','keydown','keyup','input','wheel','touchstart','touchend','scroll'])
          document.addEventListener(type,e=>fetch('/event?'+new URLSearchParams({type,trusted:String(e.isTrusted),key:e.key||'',value:e.target.value||'',x:String(e.clientX||0),y:String(e.clientY||0)})),{passive:true,capture:true});</script>
        </body></html>`);
    } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Fixture failed" })); }
  });
  await new Promise<void>((resolve) => server.listen(43198, "127.0.0.1", resolve));
  console.log(JSON.stringify({ fixture: "http://127.0.0.1:43198", bridgeNode: process.version, supervisorNode: assets.node, supervisorPid: supervisor.pid, root: assets.root }));
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await agent?.close();
    await handleWorkspaceArchived("ws-fixture").catch(() => undefined);
    remove(); server.closeAllConnections(); server.close(); supervisor.kill("SIGTERM");
    await writeFile(join(home, "fixture-evidence.json"), JSON.stringify({ events, timings, bridgeNode: process.version, supervisorNode: assets.node }, null, 2));
  };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
