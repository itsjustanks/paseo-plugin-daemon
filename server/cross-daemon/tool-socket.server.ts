// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, OWNER_ONLY_FILE } from "./private-json.server";
import type { Tools } from "./tools.server";

const toolCallSchema = z.object({ type: z.literal("call"), name: z.string().max(100), arguments: z.unknown(), callerAgentId: z.string().max(200).nullable() });

async function answer(tools: Tools, body: string): Promise<unknown> {
  try {
    const request = toolCallSchema.safeParse(JSON.parse(body));
    if (!request.success) return { error: "Malformed cross-daemon tool request" };
    return await tools.call(request.data.name, request.data.arguments ?? {}, { callerAgentId: request.data.callerAgentId });
  } catch { return { error: "Cross-daemon tool request failed; details withheld" }; }
}

export function serveTools(socketPath: string, tools: Tools): (() => Promise<void>) & { ready: Promise<void> } {
  ensurePrivateDirectory(dirname(socketPath));
  try {
    lstatSync(socketPath);
    throw new Error("Cross-daemon socket path is already occupied");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cross-daemon socket unavailable"); }
  // Node automatically unlinks its bind path on close, even if that path was replaced.
  // Bind inside a unique private directory; publish a separately inode-checked alias.
  const bindingDir = mkdtempSync(dirname(socketPath) + "/.ipc-");
  chmodSync(bindingDir, 0o700);
  const bindingPath = bindingDir + "/socket";
  let stopped = false;
  let owned: { dev: number; ino: number } | undefined;
  const unlinkOwned = () => {
    if (!owned) return;
    try {
      const current = lstatSync(socketPath);
      if (current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cross-daemon socket cleanup unavailable"); }
  };
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (stopped || sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    let body = "";
    socket.setEncoding("utf8");
    socket.setTimeout(360_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 256 * 1024) socket.destroy();
    });
    socket.on("end", () => {
      if (stopped || socket.destroyed) return;
      void answer(tools, body).then((reply) => { if (!stopped && !socket.destroyed) socket.end(JSON.stringify(reply)); });
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("Cross-daemon tool socket unavailable")));
    server.listen(bindingPath, () => {
      if (stopped) { reject(new Error("Cross-daemon stopped")); return; }
      try {
        chmodSync(bindingPath, OWNER_ONLY_FILE);
        symlinkSync(bindingPath, socketPath); // Exclusive publication: never replace an existing path.
        owned = lstatSync(socketPath);
        resolve();
      }
      catch { reject(new Error("Cross-daemon socket permissions unavailable")); }
    });
  });
  void ready.catch(() => {});
  server.on("error", () => {});
  let closing: Promise<void> | undefined;
  return Object.assign(() => {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    closing ??= ready.catch(() => {}).then(() => new Promise<void>((resolve) => {
      unlinkOwned();
      server.close(() => {
        try { rmdirSync(bindingDir); } catch { /* Never recursively remove foreign entries. */ }
        resolve();
      });
    }));
    return closing;
  }, { ready });
}
