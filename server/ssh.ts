import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { LinkState, Profile } from "../shared/link";

export function sshArgs(p: Profile): string[] {
  return ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ExitOnForwardFailure=yes", "-o", "GatewayPorts=no", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-L", `127.0.0.1:${p.localPort}:127.0.0.1:${p.remotePort}`, "-p", String(p.sshPort), p.destination];
}

export function sshFailure(stderr: string): string {
  if (/address already in use|cannot listen to port/i.test(stderr)) return "Local port is already in use. Choose another local port.";
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return "Verify this host's SSH fingerprint on the selected daemon before connecting.";
  if (/permission denied|authentication failed/i.test(stderr)) return "SSH key authentication failed. Set up a key or SSH agent on the selected daemon.";
  if (/could not resolve hostname/i.test(stderr)) return "SSH hostname could not be resolved on the selected daemon.";
  return "SSH connection failed. Check the address, SSH port, network, and key access on the selected daemon.";
}

export async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("Local port is already in use. Choose another local port.")));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

export function portReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    // Only the exact child this plugin spawned; never a PID from a snapshot or process group.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("close", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

export class SshLink {
  readonly status: LinkState;
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private probe?: ReturnType<typeof setInterval>;
  private cancelled = false;
  private failures = 0;
  private starting?: Promise<void>;

  constructor(readonly profile: Profile) {
    this.status = { id: profile.id, state: "stopped", message: "Disconnected" };
  }

  start(): void {
    this.starting = this.launch().catch(() => {
      if (!this.cancelled) this.failed("Could not start SSH on the selected daemon.");
    });
  }

  private async launch(): Promise<void> {
    this.status.state = "starting";
    this.status.message = "Connecting from the selected daemon…";
    try { await requireFreePort(this.profile.localPort); }
    catch { this.failed("Local port is already in use. Choose another local port."); return; }
    if (this.cancelled) return;
    let stderr = "";
    let finished = false;
    const child = this.child = spawn("ssh", sshArgs(this.profile), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(this.probe);
      if (!this.cancelled) this.failed(sshFailure(stderr));
    };
    child.once("error", finish);
    child.once("close", finish);
    this.probe = setInterval(() => {
      void portReady(this.profile.localPort).then((ready) => {
        if (!ready || finished || this.cancelled) return;
        this.status.state = "connected";
        this.status.message = `Forwarding localhost:${this.profile.localPort} on this daemon to remote port ${this.profile.remotePort}.`;
        this.failures = 0;
        clearInterval(this.probe);
      });
    }, 500);
  }

  private failed(message: string): void {
    if (this.cancelled) return;
    this.status.state = "retrying";
    this.status.message = message;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => this.start(), delay);
  }

  async close(): Promise<void> {
    this.cancelled = true;
    clearTimeout(this.retry);
    clearInterval(this.probe);
    await this.starting;
    await stopChild(this.child);
    this.status.state = "stopped";
    this.status.message = "Disconnected";
  }
}
