// Renders preview states in light and dark, wide and narrow, with the installed
// Google Chrome. playwright-core is not a dependency of this plugin: point
// PLAYWRIGHT_CORE at any checkout of it (default: /private/tmp/pw/node_modules/playwright-core).
//   node tests/screenshots.mjs /tmp/daemon-link-ui-after
//   SHOTS=overview,processes node tests/screenshots.mjs …   → only some states
//   PREVIEW_PORT=43298 …                                     → when 43197 is taken
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const core = process.env.PLAYWRIGHT_CORE ?? "/private/tmp/pw/node_modules/playwright-core";
const { chromium } = await import(pathToFileURL(join(core, "index.mjs")).href);
const out = resolve(process.argv[2] ?? "/tmp/daemon-link-ui-after");
mkdirSync(out, { recursive: true });

/** name → query string and the tab labels to press, in order. */
const SHOTS = {
  overview: { query: "", press: [] },
  "overview-busy": { query: "busy", press: [] },
  processes: { query: "", press: ["Processes"] },
  "processes-busy": { query: "busy", press: ["Processes"] },
  "processes-confirm": { query: "busy", press: ["Processes"], after: "confirm" },
  // 0.12.0: the "Ask an agent" sheet, from the runaway banner and from Overview's stopped dev server.
  "ask-runaway": { query: "busy", press: ["Processes"], after: "ask" },
  "ask-stopped": { query: "busy", press: [], after: "ask-last" },
  servers: { query: "", press: ["Dev servers"] },
  help: { query: "", press: ["Help"] },
  // 0.10's Connect and Project Sync tabs: old links land on Dev servers with that fold-out open.
  "link-connect": { query: "tab=connect", press: [] },
  "link-sync": { query: "tab=sync", press: [] },
  "overview-mac": { query: "mac", press: [] },
  panel: { query: "view=panel", press: [] },
  "panel-busy": { query: "view=panel&busy", press: [] },
  popover: { query: "view=popover&busy", press: [] },
  settings: { query: "view=settings", press: [] },
};
const SIZES = { wide: 1280, narrow: 420 };
const only = process.env.SHOTS?.split(",");
const port = Number(process.env.PREVIEW_PORT ?? 43197);
const server = await createServer({ configFile: join(here, "ui", "vite.config.mts"), logLevel: "error", server: { port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome" });
let failures = 0;
try {
  for (const [name, shot] of Object.entries(SHOTS).filter(([key]) => !only || only.includes(key))) {
    for (const theme of ["light", "dark"]) {
      for (const [size, width] of Object.entries(SIZES)) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const query = [shot.query, theme === "light" ? "light" : ""].filter(Boolean).join("&");
        await page.goto(`http://127.0.0.1:${port}/?${query}`);
        await page.waitForTimeout(900);
        let missing = "";
        for (const label of shot.press) {
          const tab = page.getByRole("tab", { name: label, exact: true }).first();
          if (await tab.count()) { await tab.click(); await page.waitForTimeout(700); } else missing = label;
        }
        if (shot.after === "confirm") {
          const stop = page.getByRole("button", { name: /^Stop .*heav|^Review and stop/i }).first();
          if (await stop.count()) { await stop.click(); await page.waitForTimeout(700); } else missing = "stop button";
        }
        if (shot.after === "ask" || shot.after === "ask-last") {
          const asks = page.getByRole("button", { name: "Ask an agent about this" });
          const ask = shot.after === "ask" ? asks.first() : asks.nth(1);
          if (await ask.count()) { await ask.click(); await page.waitForTimeout(900); } else missing = "Ask an agent";
        }
        if (missing) { console.log(`skip ${name}-${theme}-${size} — no "${missing}"`); await page.close(); continue; }
        const height = await page.evaluate(() => Math.max(...[...document.querySelectorAll("div")].map((el) => el.scrollHeight)));
        await page.setViewportSize({ width, height: Math.min(Math.max(900, height), 9000) });
        await page.waitForTimeout(200);
        const clipped = await page.evaluate(() => [...document.querySelectorAll("div,span")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").length);
        const file = join(out, `${name}-${theme}-${size}.png`);
        await page.screenshot({ path: file });
        const notes = [errors.length ? `${errors.length} page errors: ${errors[0].slice(0, 160)}` : "", clipped ? `${clipped} clipped boxes` : ""].filter(Boolean).join("; ");
        if (errors.length) failures += 1;
        console.log(`${notes ? "WARN" : "ok  "} ${file}${notes ? ` — ${notes}` : ""}`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures) process.exit(1);
