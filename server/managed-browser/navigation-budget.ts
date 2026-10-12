/** Ready, attached navigation budget inside the host's 30s RPC deadline.
 * Native ACK and matched main-frame commit are distinct from document loading.
 * Metadata gets one bounded post-commit phase; history needs a preflight.
 * Reattachment and held-input cleanup remain separate possible failure costs.
 */
export const NAVIGATION_ACK_TIMEOUT_MS = 10_000;
export const NAVIGATION_COMMIT_TIMEOUT_MS = 3_000;
export const NAVIGATION_METADATA_TIMEOUT_MS = 3_000;
