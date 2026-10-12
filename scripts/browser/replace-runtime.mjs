// Omer Cohen, MIT, daed6eb12f4156ca392f71c48e7a9ccca231ae8c.
import { access, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
export async function replaceRuntime(stagingRoot, runtimeRoot) {
  await access(stagingRoot);
  const root = dirname(runtimeRoot);
  const pending = join(root, `.runtime-current-${process.pid}`);
  await writeFile(pending, `${basename(stagingRoot)}\n`, { mode: 0o600 });
  try { await rename(pending, join(root, "runtime-current")); }
  finally { await rm(pending, { force: true }); }
}
