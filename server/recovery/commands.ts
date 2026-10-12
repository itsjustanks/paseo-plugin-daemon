import { RecoveryProfileSchema, type RecoveryAction, type RecoveryProfile } from "../../shared/recovery";
/** SSH joins its command arguments before invoking the remote shell. Quote every remote word. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
const words = (values: string[]) => values.map(shellQuote).join(" ");
const RESOLVE_CLI = 'if [ -x /opt/npm-global/bin/paseo ]; then cli=/opt/npm-global/bin/paseo; else cli=$(command -v paseo) || exit 127; fi';
// Run inside the target container. Never print complete status JSON; allowlist only observations of its local worker.
const STATUS_PARSER = `let state="unknown";try{const r=require("node:child_process").spawnSync(process.argv[1],["daemon","status","--json","--home",process.argv[2]],{timeout:15000,maxBuffer:65536,stdio:["ignore","pipe","ignore"],encoding:"utf8"});if(r.status===0){const s=JSON.parse(r.stdout);if(s.localDaemon==="running"&&s.connectedDaemon==="reachable"&&Number.isSafeInteger(s.workerPid)&&s.workerPid>0)state="running";else if(s.localDaemon==="stopped"&&s.connectedDaemon==="not_probed")state="worker_stopped";}}catch{}process.stdout.write(state+"\\n");`;
const WORKER_STATUS = `${RESOLVE_CLI}; node -e ${shellQuote(STATUS_PARSER)} "$cli" "\${PASEO_HOME:-$HOME/.paseo}"`;
const WORKER_RESTART = `${RESOLVE_CLI}; exec "$cli" daemon restart --timeout 20 --home "\${PASEO_HOME:-$HOME/.paseo}"`;
export function remoteCommand(value: RecoveryProfile, action: Exclude<RecoveryAction, "remove"> | "test"): string {
  const p = RecoveryProfileSchema.parse(value);
  const prefix = p.sudo && p.user !== "root" ? ["sudo", "-n", "--"] : [];
  if (action === "reboot") return words([...prefix, "systemctl", "reboot"]);
  if (action === "container_restart") {
    if (p.preset !== "docker") throw new Error("Container restart requires the Docker preset.");
    return words([...prefix, "docker", "restart", "--", p.container]);
  }
  if (p.preset === "systemd") return words([...prefix, "systemctl", action === "test" ? "is-active" : action, "--", p.unit]);
  if (action === "start") return words([...prefix, "docker", "start", "--", p.container]);
  const worker = words([...prefix, "docker", "exec", "--user", "paseo", "--", p.container, "sh", "-c", action === "test" ? WORKER_STATUS : WORKER_RESTART]);
  if (action === "restart") return worker;
  const inspect = words([...prefix, "docker", "inspect", "--format", "{{.State.Status}}", "--", p.container]);
  return `state=$(${inspect}) || exit $?; case "$state" in running) if result=$(${worker} 2>/dev/null); then case "$result" in running|worker_stopped) printf '%s\n' "$result" ;; *) printf 'worker_unknown\n' ;; esac; else printf 'worker_unknown\n'; fi ;; created|exited) printf 'container_stopped\n' ;; *) printf 'unknown\n' ;; esac`;
}
export function sshArgs(value: RecoveryProfile, command: string): string[] {
  const p = RecoveryProfileSchema.parse(value);
  return ["-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no", "-o", "PermitLocalCommand=no",
    "-o", "NumberOfPasswordPrompts=0", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    ...(p.port === null ? [] : ["-p", String(p.port)]), ...(p.user ? ["-l", p.user] : []),
    ...(p.auth.kind === "identity" ? ["-o", "IdentitiesOnly=yes", "-i", p.auth.path] : []), "--", p.hostname, command];
}
