import { createRuntimeOwner } from "./runtime-owner";
import { runStandaloneSupervisor } from "./supervisor";

// __dirname is the immutable CJS bundle directory, never the current pointer.
void createRuntimeOwner({ runtimeRoot: __dirname })
  .then(runStandaloneSupervisor)
  .catch((error: unknown) => {
    console.error("Hosts browser supervisor could not start; private error details omitted");
    process.exitCode = 1;
  });
