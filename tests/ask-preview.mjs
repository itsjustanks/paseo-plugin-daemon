// Drives "Ask an agent" and "Open a terminal here" in the preview with the installed Chrome (0.12.0):
// a busy agent is steered, a new chat gets provider/model and the prompt, Cancel sends nothing, and
// both buttons are absent without a Paseo session. Needs playwright-core, as tests/screenshots.mjs does.
//   node tests/ask-preview.mjs
import { createServer } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE ?? "/private/tmp/pw/node_modules/playwright-core", "index.mjs")).href);
const port = Number(process.env.PREVIEW_PORT ?? 43211);
const server = await createServer({ configFile: join(repo, "tests/ui/vite.config.mts"), logLevel: "error", server: { port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome" });
const out = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  // 1) Runaway → busy agent is steered.
  await page.goto(`http://127.0.0.1:${port}/?busy&light`); await page.waitForTimeout(900);
  await page.getByRole("tab", { name: "Processes", exact: true }).click(); await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Ask an agent about this" }).first().click(); await page.waitForTimeout(800);
  await page.getByRole("button", { name: /^Send to / }).click(); await page.waitForTimeout(500);
  const sent1 = await page.evaluate(() => window.__fixtureSent);
  out.push(["steer to busy agent", sent1.length === 1 && sent1[0].id === "a1" && sent1[0].options?.activeTurnBehavior === "steer" && sent1[0].text.includes("tsc (PID 4402)")]);
  out.push(["sent state shown", await page.getByText(/^Sent to Fix the checkout flow/).count() > 0]);
  // 2) Stopped dev server → new chat.
  await page.goto(`http://127.0.0.1:${port}/?busy&light`); await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Ask an agent about this" }).nth(1).click(); await page.waitForTimeout(800);
  await page.getByRole("radio", { name: "Start a new chat in main" }).click();
  await page.getByRole("button", { name: "Start the chat" }).click(); await page.waitForTimeout(500);
  const sent2 = await page.evaluate(() => window.__fixtureSent);
  out.push(["new chat created with provider/model and prompt", sent2.length === 1 && sent2[0].workspace === "ws-fixture" && sent2[0].input.config.provider === "claude/opus-5.5" && sent2[0].input.prompt.includes("Cannot find module")]);
  // 3) Cancel sends nothing.
  await page.goto(`http://127.0.0.1:${port}/?busy&light`); await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Ask an agent about this" }).first().click(); await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Cancel" }).click(); await page.waitForTimeout(300);
  out.push(["cancel sends nothing", (await page.evaluate(() => window.__fixtureSent)).length === 0]);
  // 4) No Paseo session → no button at all.
  await page.goto(`http://127.0.0.1:${port}/?busy&light&noagents`); await page.waitForTimeout(900);
  out.push(["hidden without agents API", await page.getByRole("button", { name: "Ask an agent about this" }).count() === 0]);
  // 5) Terminal button on Dev servers.
  await page.goto(`http://127.0.0.1:${port}/?light`); await page.waitForTimeout(900);
  await page.getByRole("tab", { name: "Dev servers", exact: true }).click(); await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Open a terminal here" }).first().click(); await page.waitForTimeout(400);
  out.push(["terminal toast", (await page.evaluate(() => window.__fixtureToasts)).some((t) => t.startsWith("Opened a terminal"))]);
  out.push(["no page errors", errors.length === 0]);
} finally { await browser.close(); await server.close(); }
for (const [name, ok] of out) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
