import { expect, it, vi } from "vitest";
import { workspaceBrowserOpener } from "../client/browser-navigation";
it("opens the registered remote viewer panel for the exact workspace using the documented SDK API", () => {
  const openPanel = vi.fn(); const open = workspaceBrowserOpener({ openPanel });
  open!("workspace-a"); expect(openPanel).toHaveBeenCalledExactlyOnceWith("hosts-browser", { workspaceId: "workspace-a" });
});
it("leaves unsupported runtimes without an invented navigation fallback", () => {
  expect(workspaceBrowserOpener({} as never)).toBeUndefined();
});
