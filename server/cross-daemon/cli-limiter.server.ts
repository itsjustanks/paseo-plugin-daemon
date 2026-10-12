/** FIFO transport protection shared by tool calls, queue delivery, and finish notices. */
export function createCliLimiter(limit = 4) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid cross-daemon transport limit");
  type Job = { signal?: AbortSignal; start(): void; cancel(): void };
  const queue: Job[] = [];
  const signals = new Map<AbortSignal, { jobs: Set<Job>; listener: () => void }>();
  let active = 0;
  let closed = false;
  const cancelled = () => new Error("Cross-daemon transport cancelled");

  function unwatch(job: Job) {
    if (!job.signal) return;
    const group = signals.get(job.signal);
    group?.jobs.delete(job);
    if (group && group.jobs.size === 0) {
      job.signal.removeEventListener("abort", group.listener);
      signals.delete(job.signal);
    }
  }
  function drain() {
    while (!closed && active < limit && queue.length) {
      const job = queue.shift()!;
      unwatch(job);
      if (job.signal?.aborted) { job.cancel(); continue; }
      active++;
      job.start();
    }
  }
  function watch(job: Job) {
    const signal = job.signal;
    if (!signal) return;
    let group = signals.get(signal);
    if (!group) {
      const jobs = new Set<Job>();
      const listener = () => {
        // One listener per generation, even for 1,000 queued operations.
        for (let index = queue.length - 1; index >= 0; index--) {
          if (jobs.has(queue[index])) { queue[index].cancel(); queue.splice(index, 1); }
        }
        jobs.clear(); signals.delete(signal);
        signal.removeEventListener("abort", listener);
      };
      group = { jobs, listener }; signals.set(signal, group);
      signal.addEventListener("abort", listener, { once: true });
    }
    group.jobs.add(job);
  }
  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (closed || signal?.aborted) return Promise.reject(cancelled());
      return new Promise<T>((resolve, reject) => {
        const job: Job = {
          signal, cancel: () => reject(cancelled()),
          start() {
            void Promise.resolve().then(() => {
              if (closed || signal?.aborted) throw cancelled();
              return task();
            }).then(resolve, reject).finally(() => { active--; drain(); });
          },
        };
        queue.push(job); watch(job); drain();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of queue.splice(0)) { unwatch(job); job.cancel(); }
    },
  };
}
