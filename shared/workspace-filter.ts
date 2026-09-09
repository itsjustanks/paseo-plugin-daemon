/**
 * Narrow a monitor snapshot to one workspace.
 *
 * Process rows carry a home-relative cwd (`~/...`) and project path, because the
 * server redacts the home directory before anything crosses the RPC boundary.
 * The client knows the workspace's absolute directory but not the host's home,
 * so membership is decided by matching the `~`-relative remainder against a
 * trailing segment run of the absolute directory. `/home/alice/app/web` vs
 * `~/app/web/src` matches on `app/web`; `~/app-web` does not.
 */

export interface WorkspaceTarget {
  /** Absolute workspace directory (worktree or checkout). */
  directory: string;
  /** Absolute project root; a directory-kind workspace usually equals it. */
  projectRootPath?: string | null;
  /** Workspace display name as the daemon's registry reports it. */
  name?: string | null;
}

export interface WorkspaceProcessLike {
  cwd: string | null;
  ports: readonly number[];
  project?: { path: string; workspace: string | null } | null;
}

const segments = (path: string) => path.replace(/\\/g, "/").split("/").filter(Boolean);

/** True when `cwd` is `directory` itself or a descendant, for a cwd that may be `~`-relative. */
export function cwdWithinDirectory(cwd: string | null | undefined, directory: string): boolean {
  if (!cwd || !directory) return false;
  const want = segments(directory);
  if (want.length === 0) return false;
  const have = segments(cwd);
  if (have[0] === "~") {
    const rest = have.slice(1);
    // The workspace directory must end with the first N segments of the remainder,
    // and those N segments must leave at least one segment for the home directory.
    for (let n = Math.min(rest.length, want.length - 1); n >= 1; n--) {
      const tail = want.slice(want.length - n);
      if (tail.every((segment, index) => segment === rest[index])) return true;
    }
    return false;
  }
  if (have.length < want.length) return false;
  return want.every((segment, index) => segment === have[index]);
}

/**
 * Processes that belong to the workspace: cwd inside its directory, or the
 * daemon already attributed them to a workspace with that name under its
 * project path, or they listen on a port that one of those processes uses
 * (the forwarded port of a workspace app may be held by a sibling listener).
 */
export function filterWorkspaceProcesses<P extends WorkspaceProcessLike>(processes: readonly P[], target: WorkspaceTarget, extraPorts: readonly number[] = []): P[] {
  const direct = processes.filter((process) => {
    if (cwdWithinDirectory(process.cwd, target.directory)) return true;
    const project = process.project;
    if (!project || !target.name || project.workspace !== target.name) return false;
    return cwdWithinDirectory(project.path, target.projectRootPath || target.directory) || cwdWithinDirectory(project.path, target.directory);
  });
  const ports = new Set<number>(extraPorts);
  for (const process of direct) for (const port of process.ports) ports.add(port);
  if (ports.size === 0) return direct;
  return processes.filter((process) => direct.includes(process) || process.ports.some((port) => ports.has(port)));
}

/** Ports the workspace's processes listen on, in ascending order. */
export function workspacePorts(processes: readonly WorkspaceProcessLike[]): number[] {
  return [...new Set(processes.flatMap((process) => process.ports))].sort((a, b) => a - b);
}
