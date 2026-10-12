import type { TcpEndpoint } from "./platform";

/** Internal OS rows; unknown addresses/families cannot establish ownership. */
export interface TcpListener { owner: number; address: string | null; family: 4 | 6 | null; port: number }

export function provenLoopbackEndpoints(rows: TcpListener[], owner: number): TcpEndpoint[] {
  const endpoints = new Map<string, TcpEndpoint>();
  for (const row of rows) {
    if (row.owner !== owner || !((row.address === "127.0.0.1" && row.family === 4) || (row.address === "::1" && row.family === 6))) continue;
    // A second socket in the same family (including SO_REUSEPORT), a wildcard
    // or mapped IPv6 listener that might also accept IPv4, or unknown evidence is ambiguous.
    if (rows.some((other) => other.port === row.port && other.owner !== owner &&
      (other.family === null || other.family === row.family || (other.family === 6 && other.address !== "::1")))) continue;
    const endpoint = { address: row.address, family: row.family, port: row.port } as TcpEndpoint;
    endpoints.set(`${row.family}:${row.port}`, endpoint);
  }
  return [...endpoints.values()].sort((a, b) => a.port - b.port || a.family - b.family);
}
