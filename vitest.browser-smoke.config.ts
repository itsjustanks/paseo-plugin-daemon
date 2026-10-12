import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/managed-browser/browser*.smoke.test.ts"],
  environment: "node", testTimeout: 60_000, fileParallelism: false } });
