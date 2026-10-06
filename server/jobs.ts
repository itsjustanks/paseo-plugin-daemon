import { detectService } from "./heuristics";

/**
 * What a process *is*, in the terms the Processes tab speaks: a heavy job
 * (a build, a test run, a type check, an install or a dev server), part of
 * Paseo itself, or something else. Pure functions over argv; nothing here
 * reads the system or decides whether a process may be stopped.
 */

export type JobKind = "dev-server" | "build" | "test" | "typecheck" | "install";
export interface Job { kind: JobKind; label: string }

const base = (arg: string | undefined) => (arg ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(c|m)?js$/, "");
const RUNNERS = /^(npm|npx|pnpm|pnpx|yarn|bun|bunx|deno)$/;

/** The words that name the program and its subcommand, skipping `node` and flags. */
function words(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of argv.slice(0, 8)) {
    if (arg.startsWith("-")) continue;
    const word = base(arg);
    if (out.length === 0 && /^(node|nodejs|bun|deno|python[\d.]*|env|sh|bash)$/.test(word) && argv.length > 1) continue;
    out.push(word);
  }
  return out;
}

/** A package-manager script name: `npm run build` → "build", `pnpm test` → "test". */
function script(w: readonly string[]): string | null {
  if (!RUNNERS.test(w[0] ?? "")) return null;
  if (w[1] === "run" || w[1] === "run-script") return w[2] ?? null;
  return w[1] ?? null;
}

const BUILD_SCRIPT = /^(build|compile|bundle|export|generate|dist|package)(:.*)?$/;
const TEST_SCRIPT = /^(test|tests|e2e|spec|coverage)(:.*)?$/;
const CHECK_SCRIPT = /^(typecheck|type-check|tsc|lint|check|types)(:.*)?$/;
const INSTALL = /^(install|ci|i|add)$/;

const RULES: Array<{ kind: JobKind; label: string; test: (w: readonly string[]) => boolean }> = [
  { kind: "install", label: "Package install", test: (w) => RUNNERS.test(w[0] ?? "") && INSTALL.test(w[1] ?? "") },
  { kind: "build", label: "Build", test: (w) => BUILD_SCRIPT.test(script(w) ?? "") },
  { kind: "test", label: "Tests", test: (w) => TEST_SCRIPT.test(script(w) ?? "") },
  { kind: "typecheck", label: "Type check", test: (w) => CHECK_SCRIPT.test(script(w) ?? "") },
  { kind: "build", label: "Next.js build", test: (w) => w[0] === "next" && w[1] === "build" },
  { kind: "build", label: "Vite build", test: (w) => w[0] === "vite" && w[1] === "build" },
  { kind: "build", label: "Nuxt build", test: (w) => w[0] === "nuxt" && (w[1] === "build" || w[1] === "generate") },
  { kind: "build", label: "Astro build", test: (w) => w[0] === "astro" && w[1] === "build" },
  { kind: "build", label: "Turborepo", test: (w) => w[0] === "turbo" && (w[1] === "run" || w[1] === "build") },
  { kind: "build", label: "Bundler", test: (w) => /^(webpack|rollup|tsup|rspack|parcel)$/.test(w[0] ?? "") && !w.includes("serve") && !w.includes("watch") },
  { kind: "build", label: "esbuild", test: (w) => w[0] === "esbuild" && !w.includes("--service") },
  { kind: "build", label: "Cargo build", test: (w) => w[0] === "cargo" && /^(build|b|check|clippy)$/.test(w[1] ?? "") },
  { kind: "test", label: "Cargo test", test: (w) => w[0] === "cargo" && w[1] === "test" },
  { kind: "build", label: "Go build", test: (w) => w[0] === "go" && (w[1] === "build" || w[1] === "install") },
  { kind: "test", label: "Go test", test: (w) => w[0] === "go" && w[1] === "test" },
  { kind: "build", label: "Gradle", test: (w) => /^(gradle|gradlew)$/.test(w[0] ?? "") },
  { kind: "build", label: "Docker build", test: (w) => w[0] === "docker" && (w[1] === "build" || (w[1] === "buildx" && w[2] === "build")) },
  { kind: "test", label: "Vitest", test: (w) => w[0] === "vitest" && w[1] !== "dev" },
  { kind: "test", label: "Jest", test: (w) => w[0] === "jest" || w[0] === "jest-worker" },
  { kind: "test", label: "Playwright", test: (w) => w[0] === "playwright" && w[1] === "test" },
  { kind: "test", label: "Mocha", test: (w) => w[0] === "mocha" || w[0] === "_mocha" },
  { kind: "test", label: "pytest", test: (w) => w[0] === "pytest" || (w[0] === "py.test") },
  { kind: "typecheck", label: "TypeScript", test: (w) => w[0] === "tsc" || w[0] === "vue-tsc" || w[0] === "svelte-check" },
  { kind: "typecheck", label: "Lint", test: (w) => w[0] === "eslint" || (w[0] === "biome" && /^(check|lint|ci)$/.test(w[1] ?? "")) },
];

/**
 * The heavy job a process is, or null. Builds, tests and checks are tested
 * before dev servers, because `next build` would otherwise read as the
 * Next.js dev server. Paseo's own processes are never jobs.
 */
export function classifyJob(argv: readonly string[], ports: readonly number[] = []): Job | null {
  if (argv.length === 0 || isPaseoInternal({ argv, comm: "" })) return null;
  const w = words(argv);
  const rule = RULES.find((entry) => entry.test(w));
  if (rule) return { kind: rule.kind, label: rule.label };
  const service = detectService(argv, ports);
  return service?.kind === "dev-server" ? { kind: "dev-server", label: service.label } : null;
}

/** Paseo's own processes: the daemon, its supervisor, plugin hosts, terminal workers and its bundled tools. */
export function isPaseoInternal(process: { argv: readonly string[]; comm: string }): boolean {
  const first = process.argv[0] ?? "";
  if (/^Paseo( |$)/.test(first) || /^Paseo( |$)/.test(process.comm)) return true;
  return process.argv.slice(0, 3).some((arg) => /[\\/]@getpaseo[\\/]/.test(arg) || /[\\/]Paseo\.app[\\/]/.test(arg));
}

/** A Paseo plugin host process (every plugin's server runs in one). */
export function isPluginHost(process: { argv: readonly string[] }): boolean {
  return process.argv.slice(0, 3).some((arg) => /plugin-process\.(c|m)?js$/.test(arg));
}

/** Paseo's terminal worker; its direct children are the terminals' shells. */
export function isTerminalWorker(process: { argv: readonly string[] }): boolean {
  return process.argv.slice(0, 3).some((arg) => /terminal-worker-process\.(c|m)?js$/.test(arg));
}

/**
 * A useful name for a process started through a runtime: `node …/.bin/tsc`
 * is "tsc", not "node". Anything else keeps the name it already has.
 */
export function programName(argv: readonly string[], fallback: string): string {
  const runtime = base(argv[0]);
  if (!/^(node|nodejs|bun|deno|python[\d.]*|ruby)$/.test(runtime)) return fallback;
  const script = argv.slice(1).find((arg) => !arg.startsWith("-"));
  if (!script) return fallback;
  const name = base(script).replace(/\.(ts|py|rb)$/, "");
  return name && name.length <= 40 && !/[=]/.test(name) ? name : fallback;
}

const flagValue = (argv: readonly string[], name: string): string | null => {
  const prefix = `${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

/**
 * What a Chromium or Electron helper does, from its `--type` flag (0.12.1):
 * browsers and desktop apps run a dozen processes with the same name, and
 * "Google · Outside Paseo" ten times over tells nobody anything. Null for a
 * process that isn't such a helper.
 */
export function helperRole(argv: readonly string[]): string | null {
  const type = flagValue(argv, "--type");
  if (!type) return null;
  if (type === "renderer") return argv.includes("--extension-process") ? "extension" : "window or tab";
  if (type === "gpu-process") return "graphics";
  if (type === "utility") {
    const sub = flagValue(argv, "--utility-sub-type") ?? "";
    if (/network/i.test(sub)) return "network";
    if (/audio/i.test(sub)) return "audio";
    if (/storage/i.test(sub)) return "storage";
    return "helper";
  }
  if (type === "crashpad-handler") return "crash reporter";
  return "helper";
}

/** Which part of Paseo a Paseo process is, in a word or two: "daemon", "plugin host", "window". */
export function paseoRole(process: { argv: readonly string[]; comm: string }, isDaemon: boolean): string {
  if (isDaemon) return "daemon";
  if (isPluginHost(process)) return "plugin host";
  if (isTerminalWorker(process)) return "terminals";
  const first = process.argv[0] ?? process.comm;
  if (/^Paseo Supervisor/.test(first) || /^Paseo Supervisor/.test(process.comm)) return "supervisor";
  const helper = helperRole(process.argv);
  if (helper) return helper === "window or tab" ? "window" : helper;
  if (/[\\/]Paseo\.app[\\/]Contents[\\/]MacOS[\\/]Paseo$/.test(first)) return "app";
  if (/esbuild/.test(base(first))) return "bundler";
  return "helper";
}
