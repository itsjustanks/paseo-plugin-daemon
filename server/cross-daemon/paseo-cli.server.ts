// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI gives up connecting after its own 15 s; this bounds the whole command.
class SafeCliError extends Error {}

const CLI_TIMEOUT_MS = 90_000;
const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

// Never forward stderr or child_process error.message: both may contain --host credentials.
function readCliError(stderr: string): string {
  if (/agent not found|no agent found/i.test(stderr)) return "Agent not found";
  if (/ambiguous/i.test(stderr)) return "Agent identifier is ambiguous";
  if (/is archived/i.test(stderr)) return "Agent is archived";
  if (/cannot connect|unreachable|ECONNREFUSED/i.test(stderr)) return "Cannot connect to daemon";
  return "Paseo CLI failed; details withheld to protect pairing credentials";
}

export interface PaseoCliCommand {
  command: string;
  args: string[];
  // This daemon's PASEO_HOME, for calls to its own agents.
  home: string;
}

export interface PaseoCliOptions {
  // Passed through a file, so no prompt can be read as an option or overflow the argument list.
  promptText?: string;
  signal?: AbortSignal;
}

export interface PaseoCli {
  run(link: string, args: readonly string[], options?: PaseoCliOptions): Promise<string>;
  runLocal(args: readonly string[], options?: PaseoCliOptions): Promise<string>;
}

async function withPromptFile<T>(promptText: string | undefined, use: (extraArgs: string[]) => Promise<T>): Promise<T> {
  if (promptText === undefined) return use([]);
  const dir = mkdtempSync(join(tmpdir(), "cross-daemon-"));
  const file = join(dir, "prompt.txt");
  try {
    writeFileSync(file, promptText, { mode: 0o600, flag: "wx" });
    return await use(["--prompt-file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPaseo(cli: PaseoCliCommand, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, options?: PaseoCliOptions) {
  return withPromptFile(options?.promptText, (promptArgs) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        cli.command,
        [...cli.args, ...args, ...promptArgs],
        { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: timeoutMs, signal: options?.signal, maxBuffer: CLI_MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (options?.signal?.aborted) reject(new SafeCliError("Paseo call aborted; a send may have been delivered"));
          else if (error?.killed) reject(new SafeCliError(`paseo timed out after ${timeoutMs / 1000} s`));
          else if (error) reject(new SafeCliError(readCliError(stderr)));
          else resolve(stdout.trim());
        },
      );
    }),
  ).catch((error: unknown) => {
    throw error instanceof SafeCliError ? error : new Error("Paseo CLI unavailable; details withheld to protect pairing credentials");
  });
}

export function createPaseoCli(cli: PaseoCliCommand, timeoutMs = CLI_TIMEOUT_MS): PaseoCli {
  return {
    run(link, args, options) {
      const env = { ...process.env };
      delete env.PASEO_PASSWORD;
      // Official 0.11.1 selectDaemonTarget reads PASEO_HOST. Keep credentials out of ps argv.
      delete env.PASEO_HOME;
      env.PASEO_HOST = link;
      return runPaseo(cli, args, env, timeoutMs, options);
    },
    runLocal(args, options) {
      const env = { ...process.env };
      delete env.PASEO_HOST;
      return runPaseo(cli, ["--home", cli.home, ...args], env, timeoutMs, options);
    },
  };
}
