import { describe, expect, it } from "vitest";
import { isInfrastructure } from "../server/scope";
import { programProtection, protectsDescendants } from "../server/process-protection";
import { proc } from "./fake-adapter";

const families: Array<[string, string[]]> = [
  ["PostgreSQL", ["postgres", "postmaster"]],
  ["MySQL and MariaDB", ["mysqld", "mariadbd"]],
  ["Redis-compatible servers", ["redis-server", "valkey-server", "keydb-server"]],
  ["MongoDB", ["mongod", "mongos"]],
  ["Memcached", ["memcached"]],
  ["ClickHouse", ["clickhouse", "clickhouse-server"]],
  ["service coordination", ["etcd", "consul", "nomad", "vault"]],
  ["RabbitMQ", ["rabbitmq", "rabbitmq-server"]],
  ["search servers", ["elasticsearch", "opensearch", "meilisearch", "typesense-server"]],
  ["Kafka and ZooKeeper", ["kafka", "zookeeper"]],
  ["object and time-series stores", ["minio", "influxd"]],
  ["graph and document databases", ["cassandra", "neo4j", "couchdb"]],
  ["vector and model servers", ["qdrant", "chroma", "ollama"]],
  ["container and VM services", ["dockerd", "containerd", "containerd-shim", "containerd-shim-runc-v2", "podman", "colima", "limactl", "qemu-system-aarch64", "qemu-system-x86_64"]],
  ["web servers and proxies", ["nginx", "httpd", "caddy", "traefik", "haproxy"]],
  ["OS services", ["sshd", "launchd", "systemd", "systemd-resolved", "cron", "crond", "rsyslogd"]],
  ["network services", ["tailscaled", "cloudflared"]],
  ["1Password agents", ["1password", "1password-ssh-agent", "1PasswordSSHAgent", "op-ssh-agent"]],
];

describe("executable service families", () => {
  it.each(families)("protects renamed %s executables and their descendants", (_family, executables) => {
    for (const executable of executables) {
      const raw = proc({ pid: 42, executable: `/opt/services/${executable}`, argv: ["worker"], comm: "worker" });
      expect(isInfrastructure(raw), executable).toBe(true);
      expect(programProtection(raw, "linux"), executable).toContain("database or system service");
      expect(protectsDescendants(raw, "linux"), executable).toBe(true);
    }
  });
  it.each([
    ["RabbitMQ Erlang", "beam.smp", ["worker", "-pa", "/opt/rabbitmq/ebin"]],
    ["Elasticsearch JVM", "java", ["worker", "org.elasticsearch.bootstrap.Elasticsearch"]],
    ["OpenSearch JVM", "java", ["worker", "org.opensearch.bootstrap.OpenSearch"]],
    ["Kafka JVM", "java", ["worker", "kafka.Kafka"]],
    ["ZooKeeper JVM", "java", ["worker", "org.apache.zookeeper.server.quorum.QuorumPeerMain"]],
    ["Cassandra JVM", "java", ["worker", "org.apache.cassandra.service.CassandraDaemon"]],
    ["Neo4j JVM", "java", ["worker", "org.neo4j.server.CommunityEntryPoint"]],
    ["op SSH agent", "op", ["worker", "ssh-agent"]],
    ["op SSH agent subcommand", "op", ["worker", "ssh", "agent"]],
  ] as Array<[string, string, string[]]>)("protects %s only through its real runtime executable", (_family, executable, argv) => {
    const raw = proc({ pid: 42, executable: `/opt/services/${executable}`, argv, comm: "worker" });
    expect(isInfrastructure(raw)).toBe(true);
    expect(protectsDescendants(raw, "linux")).toBe(true);
    expect(isInfrastructure({ ...raw, executable: "/usr/local/bin/node" })).toBe(false);
  });
  it("does not mistake argv or comm service names for executable identity", () => {
    expect(isInfrastructure(proc({ pid: 42, executable: "/usr/local/bin/node", comm: "mariadbd", argv: ["mariadbd"] }))).toBe(false);
    expect(isInfrastructure(proc({ pid: 42, executable: "/usr/bin/java", argv: ["java", "example.Main"] }))).toBe(false);
    expect(isInfrastructure(proc({ pid: 42, executable: "/usr/bin/beam.smp", argv: ["beam.smp", "other_app"] }))).toBe(false);
    expect(isInfrastructure(proc({ pid: 42, executable: "/usr/local/bin/op", argv: ["op", "read", "item"] }))).toBe(false);
    expect(isInfrastructure(proc({ pid: 42, executable: null, argv: ["postgres"] }))).toBe(false);
  });
  it("does not let a service argv impersonate a terminal worker or agent", () => {
    for (const argv of [["node", "/opt/@getpaseo/server/terminal/terminal-worker-process.js"], ["claude"]]) {
      const raw = proc({ pid: 42, executable: "/opt/services/mariadbd", argv });
      expect(protectsDescendants(raw, "linux")).toBe(true);
    }
  });

});
