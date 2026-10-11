import type { HkProcess } from "../server/housekeeping-plan";
export const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
export const PROFILE = `/tmp/agent-browser-chrome-${A}`;
export const proc = (extra: Partial<HkProcess> = {}): HkProcess => ({ pid: 40, ppid: 1, uid: 1000, startId: "123", exe: "/usr/bin/chrome", comm: "chrome", argv: ["chrome", `--user-data-dir=${PROFILE}`], ageSeconds: 30_000, nice: 0, agentId: A, browserDaemon: false, cwd: "/tmp", ...extra });
