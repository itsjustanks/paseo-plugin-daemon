import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { join } from "node:path";
import { contributeRecovery } from "../../server/recovery";
import { recoveryList, recoveryPreview } from "../../shared/recovery";
import { fixture } from "./fixtures";

describe("parent integration exports", () => {
  it("registers exactly six scoped RPCs without startup effects and cleans up", async () => {
    const f = fixture(), previous = process.env.PASEO_HOME, handlers = new Map<string, (input: never) => unknown>();
    try {
      process.env.PASEO_HOME = f.root;
      const close = contributeRecovery({ handle: (contract: { name: string }, handler: (input: never) => unknown) => handlers.set(contract.name, handler) } as never);
      expect([...handlers.keys()]).toHaveLength(6); expect([...handlers.keys()].every(name => name.startsWith("hosts.recovery."))).toBe(true);
      expect(handlers.get(recoveryList.name)!({} as never)).toEqual({ profiles: [], checks: {} });
      expect(() => handlers.get(recoveryPreview.name)!({ id: "10000000-0000-4000-8000-000000000001", revision: 1, action: "start" } as never)).toThrow("changed");
      await close(); await close();
    } finally { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; f.close(); }
  });
  it("bundles both public exports against the existing SDK without crossing runtime boundaries", async () => {
    const require = createRequire(join(process.cwd(), "package.json"));
    for (const runtime of ["server", "client"] as const) {
      const result = await build({ entryPoints: [runtime === "server" ? "server/recovery/index.ts" : "client/recovery/index.tsx"], bundle: true, write: false, platform: runtime === "server" ? "node" : "browser", format: "cjs", packages: "external", metafile: true });
      const code = result.outputFiles[0].text;
      if (runtime === "client") { expect(code).not.toMatch(/require\("node:/); expect(Object.keys(result.metafile!.inputs).some(path => path.startsWith("server/"))).toBe(false); }
      else { const exports: Record<string, unknown> = {}; new Function("require", "exports", "module", code)(require, exports, { exports }); expect(code).toContain("contributeRecovery"); }
    }
  });
});
