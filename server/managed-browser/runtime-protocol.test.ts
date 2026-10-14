import { describe, expect, it } from "vitest";
import { parseRuntimeRequest, RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol";

const request = { id: "request-1", version: RUNTIME_PROTOCOL_VERSION, method: "agent.request", ticket: "owned-ticket", input: {} };

describe("agent operation wire contract", () => {
  it.each(["tabs.list", "tabs.create", "tabs.select", "tabs.close"])("admits the declared %s operation", (operation) => {
    expect(parseRuntimeRequest({ ...request, operation })).toMatchObject({ id: request.id, operation });
  });

  it("accepts private client UUIDs and bounded opaque request IDs", () => {
    for (const id of ["a7b77cd7-5909-47f7-a6f4-a770e407237d", "x".repeat(128)])
      expect(parseRuntimeRequest({ ...request, id, operation: "status" })).toMatchObject({ id });
  });

  it.each(["tabs.force", "tabs.delete-all", "unknown"])("refuses undeclared %s", (operation) => {
    expect(() => parseRuntimeRequest({ ...request, operation })).toThrow("Unknown agent browser operation");
  });

  it.each(["", "x".repeat(129), "line\nbreak", { nested: "id" }, 1, null])("rejects malformed request ID %j", (id) => {
    expect(() => parseRuntimeRequest({ ...request, id, operation: "status" })).toThrow();
  });
});
