import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import * as rpc from "../../shared/recovery";
import { RecoveryStore } from "./store";
import { RecoveryService } from "./service";

/** Register inside the existing Hosts server contribution; no startup SSH, probes or hooks. */
export function contributeRecovery(server: PluginServerContext): () => Promise<void> {
  const recovery = new RecoveryService(new RecoveryStore(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "daemon-link", "recovery")));
  server.handle(rpc.recoveryList, () => recovery.list());
  server.handle(rpc.recoverySave, input => recovery.save(input));
  server.handle(rpc.recoveryTest, input => recovery.test(input.id, input.revision));
  server.handle(rpc.recoveryPreview, input => recovery.preview(input.id, input.revision, input.action));
  server.handle(rpc.recoveryConfirm, input => recovery.confirm(input.token, input.targetName));
  server.handle(rpc.recoveryCancel, input => recovery.cancel(input.token));
  return () => recovery.close();
}
