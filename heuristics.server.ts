import type { PressureState, ProcessImpact, ServiceConfidence, ServiceKind } from "./contracts.shared";

/**
 * Pure classification rules. No magic composite score: each label comes with
 * the measured reasons that produced it, and sorting stays on raw metrics.
 */

// ------------------------------------------------------------- system pressure

export interface CpuPressureInput {
  /** Current sample percent (0–100) or null before the first delta. */
  percent: number | null;
  /** Smoothed percent over the recent window. */
  sustainedPercent: number | null;
  /** Seconds the smoothed percent has stayed above the high threshold. */
  sustainedSeconds: number;
  load1: number;
  cores: number;
  psiSome10: number | null;
}

export const CPU_HIGH_PERCENT = 85;
export const CPU_CRITICAL_PERCENT = 95;
export const CPU_SUSTAIN_SECONDS = 10;

export function classifyCpuPressure(input: CpuPressureInput): { pressure: PressureState; reasons: string[] } {
  const reasons: string[] = [];
  const sustained = input.sustainedPercent ?? input.percent ?? 0;
  const loadPerCore = input.cores > 0 ? input.load1 / input.cores : 0;
  let pressure: PressureState = "normal";

  if (input.psiSome10 !== null && input.psiSome10 >= 40) {
    pressure = "critical";
    reasons.push(`tasks stalled on CPU ${input.psiSome10.toFixed(0)}% of the last 10s`);
  } else if (input.psiSome10 !== null && input.psiSome10 >= 15) {
    pressure = "high";
    reasons.push(`tasks stalled on CPU ${input.psiSome10.toFixed(0)}% of the last 10s`);
  }

  if (sustained >= CPU_CRITICAL_PERCENT && input.sustainedSeconds >= CPU_SUSTAIN_SECONDS) {
    pressure = "critical";
    reasons.push(`CPU ${sustained.toFixed(0)}% for ${Math.round(input.sustainedSeconds)}s`);
  } else if (sustained >= CPU_HIGH_PERCENT) {
    if (pressure === "normal") pressure = "high";
    reasons.push(
      input.sustainedSeconds >= 2 ? `CPU ${sustained.toFixed(0)}% for ${Math.round(input.sustainedSeconds)}s` : `CPU ${sustained.toFixed(0)}%`,
    );
  }

  if (loadPerCore >= 2) {
    if (pressure !== "critical" && sustained >= CPU_HIGH_PERCENT) pressure = "critical";
    else if (pressure === "normal") pressure = "high";
    reasons.push(`load ${input.load1.toFixed(1)} on ${input.cores} cores`);
  } else if (loadPerCore >= 1) {
    if (pressure === "normal") pressure = "high";
    reasons.push(`load ${input.load1.toFixed(1)} on ${input.cores} cores`);
  }

  return { pressure, reasons };
}

export interface MemoryPressureInput {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** Bytes of swap growth over the recent window, when known. */
  swapGrowthBytes: number | null;
  psiSome10: number | null;
  pressureSignal: "normal" | "warn" | "critical" | null;
}

export const MEMORY_HIGH_AVAILABLE_RATIO = 0.15;
export const MEMORY_CRITICAL_AVAILABLE_RATIO = 0.05;

export function classifyMemoryPressure(input: MemoryPressureInput): { pressure: PressureState; reasons: string[] } {
  const reasons: string[] = [];
  let pressure: PressureState = "normal";
  const ratio = input.totalBytes > 0 ? input.availableBytes / input.totalBytes : 1;
  const availablePercent = Math.round(ratio * 100);

  if (input.pressureSignal === "critical") {
    pressure = "critical";
    reasons.push("kernel reports critical memory pressure");
  } else if (input.pressureSignal === "warn") {
    pressure = "high";
    reasons.push("kernel reports memory pressure warning");
  }

  if (input.psiSome10 !== null && input.psiSome10 >= 25) {
    pressure = "critical";
    reasons.push(`tasks stalled on memory ${input.psiSome10.toFixed(0)}% of the last 10s`);
  } else if (input.psiSome10 !== null && input.psiSome10 >= 5) {
    if (pressure === "normal") pressure = "high";
    reasons.push(`tasks stalled on memory ${input.psiSome10.toFixed(0)}% of the last 10s`);
  }

  if (ratio <= MEMORY_CRITICAL_AVAILABLE_RATIO) {
    pressure = "critical";
    reasons.push(`${availablePercent}% memory available`);
  } else if (ratio <= MEMORY_HIGH_AVAILABLE_RATIO) {
    if (pressure === "normal") pressure = "high";
    reasons.push(`${availablePercent}% memory available`);
  }

  if (input.swapGrowthBytes !== null && input.swapGrowthBytes >= 64 * 1024 * 1024) {
    if (pressure === "normal") pressure = "high";
    reasons.push(`swap +${formatBytes(input.swapGrowthBytes)} recently`);
  } else if (input.swapTotalBytes > 0 && input.swapUsedBytes / input.swapTotalBytes >= 0.5 && ratio <= MEMORY_HIGH_AVAILABLE_RATIO) {
    reasons.push(`swap ${Math.round((input.swapUsedBytes / input.swapTotalBytes) * 100)}% used`);
  }

  return { pressure, reasons };
}

// ------------------------------------------------------------ process impact

export interface ProcessImpactInput {
  cpuPercent: number | null;
  /** Smoothed CPU percent. */
  cpuSustainedPercent: number | null;
  cpuSustainedSeconds: number;
  memoryPercent: number;
  /** RSS growth over the trailing window (bytes) and that window's length. */
  rssGrowthBytes: number | null;
  rssWindowSeconds: number;
  /** Rank among same-user processes by CPU (0 = top) and by memory. */
  cpuRank: number;
  memoryRank: number;
  systemCpuPressure: PressureState;
  systemMemoryPressure: PressureState;
}

export const PROCESS_HIGH_CPU = 50;
export const PROCESS_HIGH_MEMORY_PERCENT = 10;
export const PROCESS_DRIVER_CPU = 30;
export const DRIVER_TOP_N = 3;

export function classifyProcessImpact(input: ProcessImpactInput): { impact: ProcessImpact; reasons: string[] } {
  const reasons: string[] = [];
  const cpu = input.cpuSustainedPercent ?? input.cpuPercent ?? 0;
  const cpuNow = input.cpuPercent ?? 0;
  let impact: ProcessImpact = "normal";

  if (cpu >= PROCESS_HIGH_CPU || cpuNow >= PROCESS_HIGH_CPU) {
    impact = "high";
    reasons.push(input.cpuSustainedSeconds >= 2 ? `CPU ${Math.round(cpu)}% for ${Math.round(input.cpuSustainedSeconds)}s` : `CPU ${Math.round(cpuNow)}%`);
  }
  if (input.memoryPercent >= PROCESS_HIGH_MEMORY_PERCENT) {
    impact = "high";
    reasons.push(`${Math.round(input.memoryPercent)}% of memory`);
  }
  if (input.rssGrowthBytes !== null && input.rssGrowthBytes >= 100 * 1024 * 1024 && input.rssWindowSeconds >= 5) {
    if (impact === "normal") impact = "high";
    reasons.push(`RSS +${formatBytes(input.rssGrowthBytes)} in ${Math.round(input.rssWindowSeconds)}s`);
  }

  const cpuDriver = input.systemCpuPressure !== "normal" && input.cpuRank < DRIVER_TOP_N && cpu >= PROCESS_DRIVER_CPU;
  const memoryDriver =
    input.systemMemoryPressure !== "normal" && input.memoryRank < DRIVER_TOP_N && input.memoryPercent >= PROCESS_HIGH_MEMORY_PERCENT;
  if (cpuDriver || memoryDriver) {
    impact = "pressure-driver";
    if (cpuDriver && !reasons.some((r) => r.startsWith("CPU"))) reasons.push(`CPU ${Math.round(cpu)}%`);
    if (memoryDriver && !reasons.some((r) => r.endsWith("of memory"))) reasons.push(`${Math.round(input.memoryPercent)}% of memory`);
    reasons.push(cpuDriver ? "top CPU user during CPU pressure" : "top memory user during memory pressure");
  }

  if (impact === "normal" && cpu < 1 && cpuNow < 1 && input.memoryPercent < 1) impact = "idle";
  return { impact, reasons };
}

// ----------------------------------------------------------- service detection

export interface ServiceDetection {
  kind: ServiceKind;
  confidence: ServiceConfidence;
  label: string;
  reasons: string[];
}

interface DevServerRule {
  label: string;
  test: (argv: readonly string[], joined: string) => boolean;
  confidence: ServiceConfidence;
}

const PACKAGE_RUNNERS = /^(npm|npx|pnpm|pnpx|yarn|bun|bunx|deno)$/;
const DEV_SCRIPTS = /^(dev|start|serve|preview|storybook|watch)$/;
/**
 * Next.js's production server overwrites its own process title (and thus
 * /proc/pid/cmdline) with exactly `next-server` or `next-server (vX.Y.Z)`.
 * Anchored so a script merely containing the words ("my-next-server.sh",
 * "next-server-mock") never matches.
 */
const NEXT_SERVER_PROCESS_TITLE = /^next-server(?: \(v\d+(?:\.\d+){0,2}\))?$/;

function baseName(path: string | undefined): string {
  return (path ?? "").split("/").pop() ?? "";
}

function hasBinary(argv: readonly string[], names: RegExp): boolean {
  return argv.slice(0, 3).some((arg) => names.test(baseName(arg)));
}

const DEV_SERVER_RULES: DevServerRule[] = [
  { label: "Vite", confidence: "high", test: (argv) => hasBinary(argv, /^vite$/) },
  {
    label: "Next.js",
    confidence: "high",
    test: (argv) =>
      hasBinary(argv, /^next$/) ||
      hasBinary(argv, NEXT_SERVER_PROCESS_TITLE) ||
      argv.some((a) => /next[\\/](dist[\\/])?(bin[\\/]next|server)/.test(a)),
  },
  { label: "Nuxt", confidence: "high", test: (argv) => hasBinary(argv, /^nuxt$/) || argv.some((a) => /\.nuxt|nuxt[\\/]bin/.test(a)) },
  { label: "Astro", confidence: "high", test: (argv) => hasBinary(argv, /^astro$/) },
  { label: "Remix", confidence: "high", test: (argv) => hasBinary(argv, /^remix$/) },
  { label: "SvelteKit", confidence: "high", test: (argv) => hasBinary(argv, /^svelte-kit$/) },
  { label: "webpack", confidence: "high", test: (argv) => hasBinary(argv, /^webpack(-dev-server)?$/) || argv.some((a) => /webpack-dev-server/.test(a)) },
  { label: "Expo", confidence: "high", test: (argv) => hasBinary(argv, /^expo$/) || argv.some((a) => /@expo[\\/]cli|expo[\\/]bin/.test(a)) },
  { label: "Metro", confidence: "medium", test: (argv) => argv.some((a) => /metro[\\/](src[\\/])?cli|react-native.*start/.test(a)) },
  { label: "Storybook", confidence: "high", test: (argv) => hasBinary(argv, /^storybook$/) },
  { label: "Angular CLI", confidence: "high", test: (argv) => hasBinary(argv, /^ng$/) && argv.includes("serve") },
  { label: "Parcel", confidence: "high", test: (argv) => hasBinary(argv, /^parcel$/) },
  { label: "esbuild serve", confidence: "medium", test: (argv) => hasBinary(argv, /^esbuild$/) && argv.some((a) => a.startsWith("--serve")) },
  { label: "nodemon", confidence: "medium", test: (argv) => hasBinary(argv, /^nodemon$/) },
  { label: "tsx watch", confidence: "medium", test: (argv) => hasBinary(argv, /^tsx$/) && argv.includes("watch") },
  { label: "ts-node-dev", confidence: "medium", test: (argv) => hasBinary(argv, /^ts-node-dev$/) },
  { label: "Python http.server", confidence: "high", test: (_argv, joined) => /python[\d.]*\s+-m\s+http\.server/.test(joined) },
  { label: "Uvicorn", confidence: "high", test: (argv, joined) => hasBinary(argv, /^uvicorn$/) || /-m\s+uvicorn/.test(joined) },
  { label: "Gunicorn", confidence: "high", test: (argv) => hasBinary(argv, /^gunicorn$/) },
  { label: "Flask", confidence: "high", test: (argv, joined) => hasBinary(argv, /^flask$/) && argv.includes("run") || /-m\s+flask\s+run/.test(joined) },
  { label: "Django runserver", confidence: "high", test: (argv) => argv.includes("runserver") && argv.some((a) => baseName(a) === "manage.py") },
  { label: "Rails", confidence: "high", test: (argv) => (hasBinary(argv, /^rails$/) || argv.some((a) => baseName(a) === "rails")) && argv.some((a) => a === "server" || a === "s") },
  { label: "Puma", confidence: "high", test: (argv) => hasBinary(argv, /^puma$/) },
  { label: "PHP dev server", confidence: "high", test: (argv) => hasBinary(argv, /^php$/) && argv.includes("-S") },
  { label: "Hugo", confidence: "high", test: (argv) => hasBinary(argv, /^hugo$/) && argv.includes("server") },
  { label: "Jekyll", confidence: "high", test: (argv) => hasBinary(argv, /^jekyll$/) && argv.includes("serve") },
  { label: "Go run", confidence: "low", test: (argv) => hasBinary(argv, /^go$/) && argv.includes("run") },
  { label: "air (Go)", confidence: "medium", test: (argv) => hasBinary(argv, /^air$/) },
  { label: "cargo run", confidence: "low", test: (argv) => hasBinary(argv, /^cargo$/) && (argv.includes("run") || argv.includes("watch")) },
  { label: "Docker Compose", confidence: "low", test: (argv) => hasBinary(argv, /^docker(-compose)?$/) && argv.includes("compose") || hasBinary(argv, /^docker-compose$/) },
  { label: "http-server", confidence: "high", test: (argv) => hasBinary(argv, /^(http-server|serve|live-server|browser-sync)$/) },
  {
    label: "Package script",
    confidence: "medium",
    test: (argv) => {
      if (!PACKAGE_RUNNERS.test(baseName(argv[0]))) return false;
      const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
      return rest.some((a) => DEV_SCRIPTS.test(a)) || (rest[0] === "run" && rest[1] !== undefined && DEV_SCRIPTS.test(rest[1]));
    },
  },
];

/**
 * A listening port is the primary signal. Command patterns only add a label
 * and confidence; a listener that matches nothing is a "Listening Process",
 * never a false dev-server claim. A dev-server pattern *without* a port is
 * reported at reduced confidence so a boot-in-progress server still shows.
 */
export function detectService(argv: readonly string[], ports: readonly number[]): ServiceDetection | null {
  const joined = argv.join(" ");
  const rule = DEV_SERVER_RULES.find((r) => r.test(argv, joined));
  const listening = ports.length > 0;
  if (rule && listening) {
    return {
      kind: "dev-server",
      confidence: rule.confidence,
      label: rule.label,
      reasons: [`matches ${rule.label}`, `listening on ${ports.map((p) => `:${p}`).join(", ")}`],
    };
  }
  if (rule) {
    return { kind: "dev-server", confidence: rule.confidence === "high" ? "medium" : "low", label: rule.label, reasons: [`matches ${rule.label}`, "no listening port yet"] };
  }
  if (listening) {
    return { kind: "listener", confidence: "medium", label: "Listening Process", reasons: [`listening on ${ports.map((p) => `:${p}`).join(", ")}`] };
  }
  return null;
}

// ------------------------------------------------------------------- helpers

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (abs >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (abs >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}
