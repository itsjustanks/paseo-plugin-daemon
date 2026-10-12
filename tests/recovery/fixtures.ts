import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryDetailsSchema, type RecoveryDetails } from "../../shared/recovery";
import { RecoveryStore } from "../../server/recovery/store";
import type { SshOutcome } from "../../server/recovery/ssh";
export const details = (patch: Partial<RecoveryDetails> = {}): RecoveryDetails => RecoveryDetailsSchema.parse({ name: "Fixture target", hostname: "fixture.example.test", preset: "docker", auth: { kind: "config" }, ...patch });
export const outcome = (patch: Partial<SshOutcome> = {}): SshOutcome => ({ exitCode: 0, stdout: "running\n", stderr: "", timedOut: false, cancelled: false, started: true, ...patch });
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hosts-recovery-test-")));
  const store = new RecoveryStore(join(root, "recovery"));
  const save = (patch: Partial<RecoveryDetails> = {}) => store.save({ schemaVersion: 1, expectedRevision: 0, details: details(patch) });
  return { root, store, save, close: () => rmSync(root, { recursive: true, force: true }) };
}
