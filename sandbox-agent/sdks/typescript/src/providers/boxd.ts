import { Boxd, NotFoundError, type BoxdOptions, type MachineCreateParams } from "@boxd-sh/sdk";
import { SandboxDestroyedError } from "../client.ts";
import { buildInspectorUrl } from "../inspector.ts";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_AGENTS, SANDBOX_AGENT_INSTALL_SCRIPT, SANDBOX_AGENT_VERSION } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_CWD = "/home/boxd";
const STATE_DIR = ".sandbox-agent-boxd";
const TOKEN_PATH = `${STATE_DIR}/token`;
const ENV_PATH = `${STATE_DIR}/env`;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export type BoxdCreateOverrides = MachineCreateParams;

export interface BoxdProviderOptions {
  /** A boxd client to use. Defaults to `new Boxd(clientOptions)`, created on first use. */
  client?: Boxd;
  /** Options for the default client. `new Boxd()` reads `BOXD_API_KEY` and `BOXD_REGION`. */
  clientOptions?: BoxdOptions;
  /** Passed to `boxd.machines.create()`: `name`, `image`, `fromSnapshot`, `labels`, `deleteAfter`, `config`, and so on. */
  create?: BoxdCreateOverrides | (() => BoxdCreateOverrides | Promise<BoxdCreateOverrides>);
  /** Environment for the sandbox-agent server, such as `ANTHROPIC_API_KEY`. Written to a file only the machine user can read. */
  env?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Bearer token the server requires. The machine URL is public, so the server always runs with a token.
   * Defaults to a random token per machine, kept on the machine and read back on reconnect.
   */
  token?: string;
  /** Agents to install while the machine is created. Defaults to `["claude", "codex"]`. */
  installAgents?: readonly string[];
  agentPort?: number;
  cwd?: string;
}

async function resolveValue<T>(value: T | (() => T | Promise<T>) | undefined, fallback: T): Promise<T> {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`boxd provider received an invalid environment variable name: ${key}`);
    }
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildInstallCommand(installAgents: readonly string[]): string {
  const steps = [`sandbox-agent --version 2>/dev/null | grep -qF ${shellQuote(SANDBOX_AGENT_VERSION)} || curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`];
  for (const agent of installAgents) {
    steps.push(`sandbox-agent install-agent ${shellQuote(agent)}`);
  }
  return steps.join(" && ");
}

// A machine restored from a snapshot can already run a server that holds the
// snapshot's token, so create() stops it first. ensureServer() leaves a running
// server alone: a second one exits because the port is taken.
const STOP_SERVER_COMMAND = "pkill -x sandbox-agent; for _ in $(seq 50); do pgrep -x sandbox-agent >/dev/null || break; sleep 0.1; done";

function buildStartCommand(port: number, restart = false): string {
  return [
    ...(restart ? [`{ ${STOP_SERVER_COMMAND}; }`] : []),
    "cd ~",
    `touch ${ENV_PATH}`,
    `set -a && . ./${ENV_PATH} && set +a`,
    `nohup sandbox-agent server --token "$(cat ./${TOKEN_PATH})" --host 0.0.0.0 --port ${port} >/tmp/sandbox-agent.log 2>&1 </dev/null &`,
  ].join(" && ");
}

export function boxd(options: BoxdProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const cwd = options.cwd ?? DEFAULT_CWD;
  const installAgents = options.installAgents ?? DEFAULT_AGENTS;
  const tokens = new Map<string, string>();
  let client = options.client;

  const getClient = (): Boxd => {
    client ??= new Boxd(options.clientOptions);
    return client;
  };

  const run = async (machineId: string, command: string): Promise<void> => {
    const result = await getClient().machines.exec(machineId, {
      command: ["bash", "-lc", command],
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`boxd command failed (exit ${result.exitCode}): ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
  };

  const getToken = async (machineId: string): Promise<string> => {
    if (options.token) {
      return options.token;
    }
    const cached = tokens.get(machineId);
    if (cached) {
      return cached;
    }
    const token = new TextDecoder().decode(await getClient().machines.fs.read(machineId, TOKEN_PATH)).trim();
    tokens.set(machineId, token);
    return token;
  };

  const getUrl = async (machineId: string): Promise<string> => {
    const machine = await getClient().machines.get(machineId);
    return machine.access.url;
  };

  const provider: SandboxProvider & { getToken(sandboxId: string): Promise<string> } = {
    name: "boxd",
    defaultCwd: cwd,
    async create(): Promise<string> {
      const boxdClient = getClient();
      const createOpts = await resolveValue(options.create, {} as BoxdCreateOverrides);
      const machine = await boxdClient.machines.create(createOpts);

      try {
        await boxdClient.machines.waitUntilReady(machine.id);
        // The machine URL forwards to one port. Pin it, and turn off the browser
        // check so the SDK (not a browser) can reach the server.
        await boxdClient.machines.proxies.setPort(machine.id, agentPort);
        await boxdClient.machines.setBotProtection(machine.id, "off");

        const token = options.token ?? generateToken();
        await boxdClient.machines.fs.mkdir(machine.id, STATE_DIR, { mode: 0o700 });
        await boxdClient.machines.fs.write(machine.id, TOKEN_PATH, `${token}\n`, { mode: 0o600 });
        await boxdClient.machines.fs.write(machine.id, ENV_PATH, buildEnvFile(await resolveValue(options.env, {})), { mode: 0o600 });
        tokens.set(machine.id, token);

        await run(machine.id, buildInstallCommand(installAgents));
        await run(machine.id, buildStartCommand(agentPort, true));
      } catch (error) {
        try {
          await boxdClient.machines.delete(machine.id);
        } catch {
          // Best-effort cleanup so a failed setup does not leave a machine running.
        }
        throw error;
      }

      return machine.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      try {
        await getClient().machines.delete(sandboxId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return;
        }
        throw error;
      }
      tokens.delete(sandboxId);
    },
    async reconnect(sandboxId: string): Promise<void> {
      const machines = getClient().machines;
      let machine: Awaited<ReturnType<typeof machines.get>>;
      try {
        machine = await machines.get(sandboxId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new SandboxDestroyedError(sandboxId, "boxd", { cause: error });
        }
        throw error;
      }

      switch (machine.status) {
        case "destroyed":
          throw new SandboxDestroyedError(sandboxId, "boxd");
        case "stopped":
          await machines.start(sandboxId);
          break;
        case "suspended":
          await machines.resume(sandboxId);
          break;
        case "hibernated":
          await machines.wake(sandboxId);
          break;
      }
      await machines.waitUntilReady(sandboxId);
    },
    async pause(sandboxId: string): Promise<void> {
      await getClient().machines.hibernate(sandboxId);
    },
    async kill(sandboxId: string): Promise<void> {
      await this.destroy(sandboxId);
    },
    getUrl,
    async getInspectorUrl(sandboxId: string, baseUrl?: string): Promise<string> {
      return buildInspectorUrl({ baseUrl: baseUrl ?? (await getUrl(sandboxId)), token: await getToken(sandboxId) });
    },
    async ensureServer(sandboxId: string): Promise<void> {
      await run(sandboxId, buildStartCommand(agentPort));
    },
    getToken,
  };

  return provider;
}
