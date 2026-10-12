/** Input cleanup preserves the first failure, including an uncertain native
 * publication. Cleanup always runs once; neither phase is ever retried. */

/** Run an input phase and then its release. A cleanup error is exposed only if
 * the input phase succeeded, so a secondary failure cannot hide UNKNOWN_OUTCOME. */
export async function runWithInputCleanup<Value>(
  operation: () => Promise<Value>,
  cleanup: () => Promise<unknown>,
): Promise<Value> {
  let result: { value: Value } | { error: unknown };
  try {
    result = { value: await operation() };
  } catch (error) {
    result = { error };
  }
  try {
    await cleanup();
  } catch (error) {
    if ("value" in result) throw error;
  }
  if ("error" in result) throw result.error;
  return result.value;
}
