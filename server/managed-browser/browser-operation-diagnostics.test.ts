import { describe, expect, it } from "vitest";
import {
  type BrowserFailureDiagnostic,
  classifyBrowserFailure,
  createBrowserOperationDiagnostics,
} from "./browser-operation-diagnostics";

describe("browser operation diagnostics", () => {
  it("does not copy an arbitrary method-shaped secret into logs", () => {
    expect(classifyBrowserFailure(new Error("Page.SecretPassword timed out"))).toEqual({
      category: "timeout",
    });
  });
  it("classifies protocol codes independently of their user-facing message", () => {
    expect(
      classifyBrowserFailure(
        Object.assign(new Error("Shared Browser supervisor is busy; retry the request"), {
          code: "RUNTIME_BUSY",
        }),
      ),
    ).toEqual({ category: "capacity" });
    expect(
      classifyBrowserFailure(
        Object.assign(new Error("Obsolete connection"), { code: "BRIDGE_FENCED" }),
      ),
    ).toEqual({ category: "expired-authority" });
  });
  it("retains the failed CDP method without recording a URL, token or input", () => {
    const error = new Error(
      "Workspace frame failed: Page.getLayoutMetrics timed out after 15000ms https://private.invalid/?token=secret typed password",
    );
    expect(classifyBrowserFailure(error)).toEqual({
      category: "timeout",
      cdpMethod: "Page.getLayoutMetrics",
    });
  });

  it("rate limits independently, preserves errors and admits a later report", async () => {
    let now = 0;
    const reports: BrowserFailureDiagnostic[] = [];
    const diagnose = createBrowserOperationDiagnostics({
      now: () => now,
      report: (value) => reports.push(value),
    });
    const error = new Error("Viewer token is invalid or expired: secret");
    const fail = async () => {
      now += 10;
      throw error;
    };
    await expect(diagnose("capture", fail)).rejects.toBe(error);
    await expect(diagnose("capture", fail)).rejects.toBe(error);
    await expect(diagnose("video.read", fail)).rejects.toBe(error);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual({
      operation: "capture",
      category: "expired-authority",
      durationMs: 10,
    });
    now += 30_000;
    await expect(diagnose("capture", fail)).rejects.toBe(error);
    expect(reports).toHaveLength(3);
  });

  it("does not alter successful results or let a failing logger replace errors", async () => {
    const diagnose = createBrowserOperationDiagnostics({
      report() {
        throw new Error("logger failed");
      },
    });
    const value = {};
    expect(await diagnose("capture", async () => value)).toBe(value);
    const error = new Error("private unrelated message");
    await expect(
      diagnose("capture", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
