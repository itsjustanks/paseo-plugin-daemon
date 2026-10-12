import { lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, OWNER_ONLY_DIR } from "./private-json.server";

/** Atomic, exclusive ownership across plugin processes. Never reclaim an existing lock automatically. */
export function acquireRuntimeOwner(dir: string): (() => void) | null {
  ensurePrivateDirectory(dir);
  const path = join(dir, "runtime.lock");
  try { mkdirSync(path, { mode: OWNER_ONLY_DIR }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw new Error("Cross-daemon runtime ownership unavailable");
  }
  const owned = lstatSync(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = lstatSync(path);
      if (current.dev === owned.dev && current.ino === owned.ino && current.isDirectory()) rmdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cross-daemon runtime ownership cleanup unavailable");
    }
  };
}
