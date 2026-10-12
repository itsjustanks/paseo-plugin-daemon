/** Shared bounds for custom viewports, frame contracts, and the agent adapter. */
export const MIN_VIEWPORT = { width: 320, height: 480 } as const;
export const MAX_VIEWPORT = { width: 3840, height: 3840 } as const;
/** Agents keep the smaller original bound; humans may choose any size up to MAX_VIEWPORT. */
export const MAX_AGENT_VIEWPORT = { width: 1600, height: 1200 } as const;
