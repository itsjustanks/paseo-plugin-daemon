import { spawn, type ChildProcess } from "node:child_process";
import type { RecoveryResult } from "../../shared/recovery";

export type SshOutcome = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; started: boolean };
export type SshRun = (args: string[], signal: AbortSignal) => Promise<SshOutcome>;
export type SpawnSsh = (args: string[]) => ChildProcess;
const defaultSpawn: SpawnSsh = args => spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
/** No shell, stdin, logging, output passthrough or retry. Resolve within the deadline even if close never arrives. */
export function createSshRun(spawnSsh: SpawnSsh = defaultSpawn, timeoutMs = 25_000, killGraceMs = 500): SshRun {
  return (args, signal) => new Promise(resolve => {
    let child: ChildProcess | undefined, stdout = "", stderr = "", timedOut = false, cancelled = false, started = false, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", abort);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, started });
    };
    const stop = () => {
      try { child?.kill("SIGTERM"); } catch { /* Already exited. */ }
      killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* Already exited. */ } finish(null); }, killGraceMs);
    };
    const abort = () => { cancelled = true; stop(); };
    if (signal.aborted) { cancelled = true; finish(null); return; }
    try { child = spawnSsh(args); }
    catch { finish(null); return; }
    child.once("spawn", () => { started = true; });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-4096); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.once("error", () => finish(null));
    child.once("close", code => finish(code));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal.aborted) abort();
  });
}
export function classifySsh(outcome: SshOutcome, mutation: boolean, now: number, reboot = false): RecoveryResult {
  const result = (code: RecoveryResult["code"], message: string, state: RecoveryResult["state"] = "unknown"): RecoveryResult => ({ code, message, state, checkedAt: now });
  if (outcome.timedOut || outcome.cancelled) {
    if (mutation && outcome.started) return result("uncertain", "The SSH operation ended before its result was known. The request may have taken effect. Do not retry automatically; check the target separately.");
    return outcome.cancelled ? result("cancelled", "The check was cancelled.") : result("unreachable", "SSH timed out. Check the target's network and SSH service from this runner.");
  }
  // SSH diagnostics stay local and are used only for classification. No raw values leave this module.
  if (outcome.exitCode === 255) {
    if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no .* host key is known/i.test(outcome.stderr)) return result("host_key", "Verify the target's SSH fingerprint through a trusted channel and configure known_hosts on this runner. Hosts never accepts unknown or changed keys.");
    if (/permission denied|authentication failed|sign_and_send_pubkey|no mutual signature/i.test(outcome.stderr)) return result("auth", "SSH key authentication failed. Check the key file or agent on this runner. Password prompts are disabled.");
    if (/could not resolve hostname|connection refused|no route to host|network is unreachable|connection timed out/i.test(outcome.stderr)) return result("unreachable", "The runner could not reach the target's SSH service. Check its hostname, port and network.");
    if (mutation) return result("uncertain", reboot ? "Reboot request sent or connection closed. Recovery is not verified. Check the target separately after it returns; do not retry automatically." : "SSH disconnected. The request may have taken effect. Check the target separately before retrying.");
    return result("unreachable", "SSH connection failed. Check network, host fingerprint and key access on this runner.");
  }
  if (!outcome.started && outcome.exitCode === null) return result("unavailable", "SSH could not start on this runner. Install or repair its SSH client outside Hosts.");
  if (outcome.exitCode === 0) {
    if (mutation) return result("sent", reboot ? "Reboot request sent. Recovery is not verified. Check separately after the host returns." : "Request completed over SSH. Check separately to verify Paseo is available.");
    const state = outcome.stdout.trim();
    if (state === "container_stopped") return result("checked", "SSH connected; the existing Paseo container is stopped.", "stopped");
    if (state === "worker_stopped") return result("checked", "SSH connected; the container is still running, but the Paseo worker is stopped. Start container cannot restart a worker in a running container. If the worker RPC is unavailable, review Restart existing container; it interrupts all work inside.", "stopped");
    if (state === "worker_unknown") return result("checked", "SSH connected; the container is running, but the Paseo worker's status could not be verified. If the worker RPC is unavailable, review Restart existing container; it interrupts all work inside.");
    return result("checked", state === "active" || state === "running" ? "SSH connected; the configured Paseo service reports running." : "SSH connected; Paseo's running state could not be verified.", state === "active" || state === "running" ? "running" : "unknown");
  }
  // systemctl is-active uses 3 for inactive and 4 for an unknown unit.
  if (!mutation && outcome.exitCode === 3 && /^(inactive|failed)$/.test(outcome.stdout.trim())) return result("checked", "SSH connected; the configured service reports stopped or failed.", "stopped");
  if (mutation) return result("uncertain", "The remote command did not confirm completion. It may have taken effect. Check the target separately before retrying.");
  return result("failed", "SSH connected, but the fixed action failed. Check the configured container or service and the runner's non-interactive permissions. Raw command output is not displayed.");
}
