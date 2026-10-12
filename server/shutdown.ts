type Stop = () => unknown;
/** Calling a stop must cancel authority now, even when its asynchronous teardown stalls. */
function start(stop: Stop): Promise<unknown> {
  try { return Promise.resolve(stop()); } catch (error) { return Promise.reject(error); }
}
/** Invoke every cancellation before awaiting anything; one faulty cleanup cannot skip later stops. */
export function stopActiveWork(stops: { cross: Stop; recovery: Stop; housekeeping: Stop; browsers: Stop; cancel?: readonly Stop[]; close?: readonly Stop[] }): Promise<PromiseSettledResult<unknown>[]> {
  const crossStopped = start(stops.cross);
  const recoveryStopped = start(stops.recovery);
  const housekeepingStopped = start(stops.housekeeping);
  const browserStopped = start(stops.browsers);
  const cancelled = (stops.cancel ?? []).map(start);
  const closed = (stops.close ?? []).map(start);
  return Promise.allSettled([crossStopped, recoveryStopped, housekeepingStopped, browserStopped, ...cancelled, ...closed]);
}
