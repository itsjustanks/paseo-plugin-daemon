import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer as createSocketServer, type Server } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDiscovery } from '../server/browser-discovery';
import { DarwinAdapter, PS_FORMAT } from '../server/darwin';
import { FakeAdapter, proc } from './fake-adapter';

let directory: string;
let socket: Server;
const uid = process.getuid!();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hosts-review-findings-'));
  socket = createSocketServer();
  await new Promise<void>(resolve => socket.listen(join(directory, 'default.sock'), resolve));
  await writeFile(join(directory, 'default.pid'), '42');
});
afterEach(async () => {
  await new Promise<void>(resolve => socket.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
function processes() {
  return [proc({ pid: 42, uid, executable: '/bin/agent-browser', argv: ['/bin/agent-browser'], cwd: directory }),
    proc({ pid: 43, uid, ppid: 42, executable: '/bin/chrome', argv: ['/bin/chrome', '--remote-debugging-port=0'], cwd: directory })];
}
it('rejects a macOS listener owner change within the existing five-second port cache', async () => {
  let now = 1000; let output = 'p43\nn127.0.0.1:9222\n'; let scans = 0;
  const darwin = new DarwinAdapter({ now: () => now, exec: async () => { scans++; return output; } });
  const adapter = new FakeAdapter(); adapter.processes = processes();
  adapter.listeningPorts = darwin.listeningPorts.bind(darwin);
  adapter.freshListeningEndpoints = darwin.freshListeningEndpoints.bind(darwin);
  const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
  const session = (await discovery.list()).sessions[0]!;
  expect(session.row.viewable).toBe(true);
  await adapter.listeningPorts([43]); const scansBefore = scans;
  output = 'p99\nn127.0.0.1:9222\n'; now += 1000;
  await expect(discovery.verify(session)).rejects.toThrow('listener changed');
  expect(scans).toBe(scansBefore + 1);
  expect((await adapter.listeningPorts([43])).ports.get(43)).toEqual([9222]);
  now += 5000;
  await expect(discovery.verify(session)).rejects.toThrow('listener changed');
});
it('never probes unowned IPv4 when Chrome owns only the same port on IPv6', async () => {
  let requests = 0;
  const http = createHttpServer((_req, res) => { requests++; res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/foreign` })); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  try {
    const darwin = new DarwinAdapter({ portCacheMs: 0, exec: async () => `p43\nn[::1]:${port}\np99\nn127.0.0.1:${port}\n` });
    const adapter = new FakeAdapter(); adapter.processes = processes();
    adapter.listeningPorts = darwin.listeningPorts.bind(darwin);
    adapter.freshListeningEndpoints = darwin.freshListeningEndpoints.bind(darwin);
    const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
    const session = (await discovery.list()).sessions[0]!;
    expect(session.row.viewable).toBe(true);
    await expect(discovery.endpoint(session)).rejects.toThrow();
    expect(requests).toBe(0);
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
it('attributes a Unix-only macOS daemon using its matched fresh identity cwd', async () => {
  const rows = processes();
  const psLine = (p: typeof rows[number]) => `${p.pid} ${p.ppid} ${p.uid} S 4096 0:00.00 00:01 Mon Oct 12 09:00:00 2026 ${p.argv.join(' ')}`;
  const adapter = new DarwinAdapter({ portCacheMs: 0, exec: async (file, args) => {
    if (file === 'ps' && args.includes(PS_FORMAT)) return rows.filter(p => !args.includes('-p') || p.pid === Number(args[args.indexOf('-p') + 1])).map(psLine).join('\n');
    if (file === 'ps' && args.includes('comm=')) return rows.find(p => p.pid === Number(args[args.indexOf('-p') + 1]))!.executable!;
    if (file === 'ps' && args.includes('pid=,comm=')) return rows.map(p => `${p.pid} ${p.executable}`).join('\n');
    if (file === 'ps') return rows.map(p => `${p.pid} ${p.argv.join(' ')}`).join('\n');
    if (file === 'lsof' && args[0] === '-nP') return 'p43\nn127.0.0.1:9222\n';
    if (file === 'lsof' && args.includes('cwd')) return `n${directory}\n`;
    if (file === 'lsof' && args.includes('txt')) return rows.map(p => `p${p.pid}\nn${p.executable}`).join('\n');
    throw new Error('unexpected fixture command');
  } });
  const sampled = await adapter.sampleProcesses(uid);
  expect(sampled.processes.find(p => p.pid === 42)!.cwd).toBeNull();
  expect((await adapter.readIdentity(42))!.cwd).toBe(directory);
  const scope = { workspaceDescriptors: async () => [{ id: 'workspace-a', name: 'Fixture', workspaceDirectory: directory }], agent: () => null } as never;
  const discovery = new BrowserDiscovery({ adapter, uid, scope, roots: [directory] });
  const session = (await discovery.list()).sessions[0]!;
  expect(session.row.viewable).toBe(true);
  expect(session.row.workspaceId).toBe('workspace-a');
  expect(session.row.attribution).toBe('workspace');
});

it('fails closed when fresh endpoint proof is absent, without falling back to cached port numbers', async () => {
  const adapter = new FakeAdapter(); adapter.processes = processes(); adapter.ports.set(43, [9222]);
  Object.assign(adapter, { freshListeningEndpoints: undefined });
  const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
  const session = (await discovery.list()).sessions[0]!;
  expect(session.row.viewable).toBe(false); expect(adapter.portScans).toBe(0);
  await expect(discovery.endpoint(session)).rejects.toThrow('cannot safely attach');
});
it('times out ownership checks and prevents late identity reads from starting listener work', async () => {
  const adapter = new FakeAdapter(); adapter.processes = processes(); adapter.ports.set(43, [9222]);
  const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
  const session = (await discovery.list()).sessions[0]!;
  const identity = await adapter.readIdentity(42); let finish!: (value: typeof identity) => void;
  const scans = adapter.portScans;
  vi.spyOn(adapter, 'readIdentity').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  try {
    const checking = discovery.verify(session); const rejected = expect(checking).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(finish).toBeDefined());
    await vi.advanceTimersByTimeAsync(3001); await rejected;
    finish(identity); await vi.advanceTimersByTimeAsync(1);
    expect(adapter.portScans).toBe(scans);
  } finally { vi.useRealTimers(); }
});
it('checks endpoint ownership before HTTP and again after an otherwise valid HTTP response', async () => {
  let requests = 0; let moveOwnership = false;
  const adapter = new FakeAdapter(); adapter.processes = processes();
  const http = createHttpServer((_req, res) => {
    requests++; if (moveOwnership) adapter.ports.clear();
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  try {
    adapter.ports.set(43, [port]); const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
    const session = (await discovery.list()).sessions[0]!;
    adapter.ports.clear(); await expect(discovery.endpoint(session)).rejects.toThrow('listener changed'); expect(requests).toBe(0);
    adapter.ports.set(43, [port]); moveOwnership = true;
    await expect(discovery.endpoint(session)).rejects.toThrow('listener changed'); expect(requests).toBe(1);
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

it('refuses an already-discovered endpoint if the fresh ownership capability disappears', async () => {
  const adapter = new FakeAdapter(); adapter.processes = processes(); adapter.ports.set(43, [9222]);
  const discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
  const session = (await discovery.list()).sessions[0]!;
  Object.assign(adapter, { freshListeningEndpoints: undefined });
  await expect(discovery.verify(session)).rejects.toThrow('ownership is unavailable');
});
