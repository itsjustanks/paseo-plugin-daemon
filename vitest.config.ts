import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Server-side modules are unit-tested. The React Native client
      // (client/ and index.client.tsx) has a separate browser preview harness.
      include: ["server/**/*.ts", "shared/**/*.ts"],
      thresholds: {
        // Floors the current suite already clears; raise them, don't lower them.
        statements: 80,
        branches: 65,
        functions: 85,
        lines: 85,
        // The redaction boundary is safety-critical and must stay fully covered.
        "server/redaction.ts": {
          statements: 95,
          branches: 85,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
