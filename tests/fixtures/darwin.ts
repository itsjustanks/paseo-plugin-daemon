/** `ps -axo pid=,ppid=,uid=,state=,rss=,time=,etime=,lstart=,command=` */
export const PS_OUTPUT = `    1     0     0 Ss   12345   1:23.45  10-02:03:04 Mon Sep  1 08:00:00 2026 /sbin/launchd
  501     1   501 S     4096   0:00.12     01:02:03 Thu Sep  4 09:00:00 2026 /usr/bin/login -fp alice
  777   501   501 R   204800  12:34.56        05:00 Thu Sep  4 09:55:00 2026 node /Users/alice/app/node_modules/.bin/vite --port 5173
  778   777   501 Z        0   0:00.00        00:01 Thu Sep  4 09:59:59 2026 (node)
`;

/** `ps -axo pid=,ppid=,uid=,lstart=` */
export const PS_TREE_OUTPUT = `    1     0     0 Mon Sep  1 08:00:00 2026
  501     1   501 Thu Sep  4 09:00:00 2026
  777   501   501 Thu Sep  4 09:55:00 2026
  778   777   501 Thu Sep  4 09:59:59 2026
`;

export const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            200000.
Pages inactive:                          100000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                           2000.
"Translation faults":                 123456789.
Pages occupied by compressor:             80000.
File-backed pages:                        90000.
Anonymous pages:                         210000.
`;

export const SWAPUSAGE = "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)\n";

export const LSOF_LISTEN = `p777
f23
n*:5173
f24
n127.0.0.1:5173
p900
f5
n[::1]:8080
`;

export const LSOF_CWD = `p777
fcwd
n/Users/alice/app
`;
