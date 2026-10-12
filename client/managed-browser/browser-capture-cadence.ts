/** Single-flight capture cadence; active input improves playback without changing image quality. */
export function browserCaptureInterval(status: string | undefined, activeInput: boolean): number {
  if (status !== "ready") return 1_500;
  if (activeInput) return 100;
  return 250;
}
