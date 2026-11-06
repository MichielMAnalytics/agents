import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxAgent, SandboxDestroyedError, type SandboxProvider } from "../src/index.ts";

const e2bMocks = vi.hoisted(() => {
  class MockNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NotFoundError";
    }
  }

  return {
    MockNotFoundError,
    betaCreate: vi.fn(),
    connect: vi.fn(),
  };
});

const modalMocks = vi.hoisted(() => ({
  appsFromName: vi.fn(),
  imageFromRegistry: vi.fn(),
  secretFromObject: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxFromId: vi.fn(),
}));

const computeSdkMocks = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const spritesMocks = vi.hoisted(() => ({
  createSprite: vi.fn(),
  getSprite: vi.fn(),
  deleteSprite: vi.fn(),
}));

const boxdMocks = vi.hoisted(() => {
  class MockNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NotFoundError";
    }
  }

  return {
    MockNotFoundError,
    clientOptions: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    waitUntilReady: vi.fn(),
    exec: vi.fn(),
    start: vi.fn(),
    resume: vi.fn(),
    wake: vi.fn(),
    hibernate: vi.fn(),
    setBotProtection: vi.fn(),
    setPort: vi.fn(),
    fsMkdir: vi.fn(),
    fsWrite: vi.fn(),
    fsRead: vi.fn(),
  };
});

vi.mock("@boxd-sh/sdk", () => ({
  NotFoundError: boxdMocks.MockNotFoundError,
  Boxd: class MockBoxd {
    constructor(options?: unknown) {
      boxdMocks.clientOptions(options);
    }

    machines = {
      create: boxdMocks.create,
      get: boxdMocks.get,
      delete: boxdMocks.delete,
      waitUntilReady: boxdMocks.waitUntilReady,
      exec: boxdMocks.exec,
      start: boxdMocks.start,
      resume: boxdMocks.resume,
      wake: boxdMocks.wake,
      hibernate: boxdMocks.hibernate,
      setBotProtection: boxdMocks.setBotProtection,
      proxies: { setPort: boxdMocks.setPort },
      fs: { mkdir: boxdMocks.fsMkdir, write: boxdMocks.fsWrite, read: boxdMocks.fsRead },
    };
  },
}));

vi.mock("@e2b/code-interpreter", () => ({
  NotFoundError: e2bMocks.MockNotFoundError,
  Sandbox: {
    betaCreate: e2bMocks.betaCreate,
    connect: e2bMocks.connect,
  },
}));

vi.mock("modal", () => ({
  ModalClient: class MockModalClient {
    apps = { fromName: modalMocks.appsFromName };
    images = { fromRegistry: modalMocks.imageFromRegistry };
    secrets = { fromObject: modalMocks.secretFromObject };
    sandboxes = {
      create: modalMocks.sandboxCreate,
      fromId: modalMocks.sandboxFromId,
    };
  },
}));

vi.mock("computesdk", () => ({
  compute: {
    sandbox: {
      create: computeSdkMocks.create,
      getById: computeSdkMocks.getById,
    },
  },
}));

vi.mock("@fly/sprites", () => ({
  SpritesClient: class MockSpritesClient {
    readonly token: string;
    readonly baseURL: string;

    constructor(token: string, options: { baseURL?: string } = {}) {
      this.token = token;
      this.baseURL = options.baseURL ?? "https://api.sprites.dev";
    }

    createSprite = spritesMocks.createSprite;
    getSprite = spritesMocks.getSprite;
    deleteSprite = spritesMocks.deleteSprite;
  },
}));

import { e2b } from "../src/providers/e2b.ts";
import { modal } from "../src/providers/modal.ts";
import { computesdk } from "../src/providers/computesdk.ts";
import { agentcomputer } from "../src/providers/agentcomputer.ts";
import { sprites } from "../src/providers/sprites.ts";
import { boxd } from "../src/providers/boxd.ts";

function createFetch(): typeof fetch {
  return async () => new Response(null, { status: 200 });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function createBaseProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: "mock",
    async create(): Promise<string> {
      return "created";
    },
    async destroy(): Promise<void> {},
    async getUrl(): Promise<string> {
      return "http://127.0.0.1:3000";
    },
    ...overrides,
  };
}

function createMockSandbox() {
  return {
    sandboxId: "sbx-123",
    getHost: vi.fn(() => "sandbox.example"),
    betaPause: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    },
  };
}

function createMockModalImage() {
  return {
    dockerfileCommands: vi.fn(function dockerfileCommands() {
      return this;
    }),
  };
}

beforeEach(() => {
  e2bMocks.betaCreate.mockReset();
  e2bMocks.connect.mockReset();
  modalMocks.appsFromName.mockReset();
  modalMocks.imageFromRegistry.mockReset();
  modalMocks.secretFromObject.mockReset();
  modalMocks.sandboxCreate.mockReset();
  modalMocks.sandboxFromId.mockReset();
  computeSdkMocks.create.mockReset();
  computeSdkMocks.getById.mockReset();
  spritesMocks.createSprite.mockReset();
  spritesMocks.getSprite.mockReset();
  spritesMocks.deleteSprite.mockReset();
  for (const mock of Object.values(boxdMocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
});

describe("SandboxAgent provider lifecycle", () => {
  it("reconnects an existing sandbox before ensureServer", async () => {
    const order: string[] = [];
    const provider = createBaseProvider({
      reconnect: vi.fn(async () => {
        order.push("reconnect");
      }),
      ensureServer: vi.fn(async () => {
        order.push("ensureServer");
      }),
    });

    const sdk = await SandboxAgent.start({
      sandbox: provider,
      sandboxId: "mock/existing",
      skipHealthCheck: true,
      fetch: createFetch(),
    });

    expect(order).toEqual(["reconnect", "ensureServer"]);

    await sdk.killSandbox();
  });

  it("surfaces SandboxDestroyedError from reconnect", async () => {
    const provider = createBaseProvider({
      reconnect: vi.fn(async () => {
        throw new SandboxDestroyedError("existing", "mock");
      }),
      ensureServer: vi.fn(async () => undefined),
    });

    await expect(
      SandboxAgent.start({
        sandbox: provider,
        sandboxId: "mock/existing",
        skipHealthCheck: true,
        fetch: createFetch(),
      }),
    ).rejects.toBeInstanceOf(SandboxDestroyedError);

    expect(provider.ensureServer).not.toHaveBeenCalled();
  });

  it("uses provider pause and kill hooks for explicit lifecycle control", async () => {
    const pause = vi.fn(async () => undefined);
    const kill = vi.fn(async () => undefined);
    const provider = createBaseProvider({ pause, kill });

    const paused = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });
    await paused.pauseSandbox();
    expect(pause).toHaveBeenCalledWith("created");

    const killed = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });
    await killed.killSandbox();
    expect(kill).toHaveBeenCalledWith("created");
  });

  it("uses provider-specific inspector URLs when provided", async () => {
    const provider = createBaseProvider({
      async getUrl(): Promise<string> {
        return "https://sandbox.example";
      },
      async getInspectorUrl(): Promise<string> {
        return "https://sandbox.example/ui/?access_token=test-token";
      },
    });

    const sdk = await SandboxAgent.start({
      sandbox: provider,
      skipHealthCheck: true,
      fetch: createFetch(),
    });

    expect(sdk.inspectorUrl).toBe("https://sandbox.example/ui/?access_token=test-token");

    await sdk.killSandbox();
  });
});

describe("e2b provider", () => {
  it("creates sandboxes with betaCreate, autoPause, and the default timeout", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      create: {
        envs: { ANTHROPIC_API_KEY: "test" },
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-123");

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowInternetAccess: true,
        autoPause: true,
        timeoutMs: 3_600_000,
        envs: { ANTHROPIC_API_KEY: "test" },
      }),
    );
  });

  it("allows timeoutMs and autoPause to be overridden", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      timeoutMs: 123_456,
      autoPause: false,
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        autoPause: false,
        timeoutMs: 123_456,
      }),
    );
  });

  it("pauses by default in destroy and uses kill for permanent deletion", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.connect.mockResolvedValue(sandbox);
    const provider = e2b();

    await provider.destroy("sbx-123");
    expect(e2bMocks.connect).toHaveBeenLastCalledWith("sbx-123", { timeoutMs: 3_600_000 });
    expect(sandbox.betaPause).toHaveBeenCalledTimes(1);
    expect(sandbox.kill).not.toHaveBeenCalled();

    await provider.kill?.("sbx-123");
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("maps missing reconnect targets to SandboxDestroyedError", async () => {
    e2bMocks.connect.mockRejectedValue(new e2bMocks.MockNotFoundError("gone"));
    const provider = e2b();

    await expect(provider.reconnect?.("missing-sandbox")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it("passes a configured template to betaCreate", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      template: "my-template",
      create: { envs: { ANTHROPIC_API_KEY: "test" } },
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      "my-template",
      expect.objectContaining({
        allowInternetAccess: true,
        envs: { ANTHROPIC_API_KEY: "test" },
        timeoutMs: 3_600_000,
      }),
    );
  });

  it("accepts legacy create.template values from plain JavaScript", async () => {
    const sandbox = createMockSandbox();
    e2bMocks.betaCreate.mockResolvedValue(sandbox);

    const provider = e2b({
      create: { template: "legacy-template" } as never,
    });

    await provider.create();

    expect(e2bMocks.betaCreate).toHaveBeenCalledWith(
      "legacy-template",
      expect.objectContaining({
        allowInternetAccess: true,
        timeoutMs: 3_600_000,
      }),
    );
  });
});

describe("modal provider", () => {
  it("uses the configured base image when building the sandbox image", async () => {
    const app = { appId: "app-123" };
    const image = createMockModalImage();
    const sandbox = {
      sandboxId: "sbx-modal",
      exec: vi.fn(),
    };

    modalMocks.appsFromName.mockResolvedValue(app);
    modalMocks.imageFromRegistry.mockReturnValue(image);
    modalMocks.sandboxCreate.mockResolvedValue(sandbox);

    const provider = modal({
      image: "python:3.12-slim",
      create: {
        appName: "custom-app",
        secrets: { OPENAI_API_KEY: "test" },
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-modal");

    expect(modalMocks.appsFromName).toHaveBeenCalledWith("custom-app", { createIfMissing: true });
    expect(modalMocks.imageFromRegistry).toHaveBeenCalledWith("python:3.12-slim");
    expect(image.dockerfileCommands).not.toHaveBeenCalled();
    expect(modalMocks.sandboxCreate).toHaveBeenCalledWith(
      app,
      image,
      expect.objectContaining({
        encryptedPorts: [3000],
        memoryMiB: 2048,
      }),
    );
  });
});

describe("computesdk provider", () => {
  it("passes image and template options through to compute.sandbox.create", async () => {
    const sandbox = {
      sandboxId: "sbx-compute",
      runCommand: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    };
    computeSdkMocks.create.mockResolvedValue(sandbox);

    const provider = computesdk({
      create: {
        envs: { ANTHROPIC_API_KEY: "test" },
        image: "ghcr.io/example/sandbox-agent:latest",
        templateId: "tmpl-123",
      },
    });

    await expect(provider.create()).resolves.toBe("sbx-compute");

    expect(computeSdkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        envs: { ANTHROPIC_API_KEY: "test" },
        image: "ghcr.io/example/sandbox-agent:latest",
        templateId: "tmpl-123",
      }),
    );
  });
});

describe("agentcomputer provider", () => {
  it("creates managed-worker computers with platform defaults and exposes an auth-ready inspector URL", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "pending" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ id: "cmp_123", status: "starting" }))
      .mockResolvedValueOnce(jsonResponse({ connection: { web_url: "https://box.agentcomputer.example" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_url: "https://box.agentcomputer.example?access_token=browser-token",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const sdk = await SandboxAgent.start({
      sandbox: agentcomputer({
        apiKey: "ac_live_test",
        fetch: fetchMock,
        pollIntervalMs: 0,
      }),
    });

    expect(sdk.sandboxId).toBe("agentcomputer/cmp_123");
    expect(sdk.inspectorUrl).toBe("https://box.agentcomputer.example/ui/?access_token=browser-token");

    const health = await sdk.getHealth();
    expect(health.status).toBe("ok");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.computer.agentcomputer.ai/v1/computers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          runtime_family: "managed-worker",
          use_platform_default: true,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.computer.agentcomputer.ai/v1/computers/cmp_123/connection",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );

    const browserAccessRequest = fetchMock.mock.calls[4];
    expect(browserAccessRequest?.[0]).toBe("https://api.computer.agentcomputer.ai/v1/computers/cmp_123/access/browser");

    const sandboxHealthRequest = fetchMock.mock.calls[5]?.[0];
    expect(sandboxHealthRequest).toBeInstanceOf(Request);
    const sandboxHealthHeaders = new Headers((sandboxHealthRequest as Request).headers);
    expect(sandboxHealthHeaders.get("cookie")).toContain("agentcomputer_access_session=browser-token");

    await sdk.killSandbox();
  });

  it("maps missing computers to SandboxDestroyedError during reconnect", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = agentcomputer({
      apiKey: "ac_live_test",
      fetch: fetchMock,
    });

    await expect(provider.reconnect?.("cmp_missing")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });
});

describe("sprites provider", () => {
  it("creates a sprite, installs sandbox-agent, and configures the managed service", async () => {
    const sprite = {
      name: "sprite-1",
      execFile: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    spritesMocks.createSprite.mockResolvedValue(sprite);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: { status: "stopped" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
      create: {
        name: "sprite-1",
      },
      env: {
        OPENAI_API_KEY: "test'value",
      },
    });

    await expect(provider.create()).resolves.toBe("sprite-1");

    expect(spritesMocks.createSprite).toHaveBeenCalledWith("sprite-1", undefined);
    expect(sprite.execFile).not.toHaveBeenCalled();

    const putCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/services/sandbox-agent") && init?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(String(putCall?.[0])).toContain("/v1/sprites/sprite-1/services/sandbox-agent");
    expect(putCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer sprite-token",
      "Content-Type": "application/json",
    });
    const serviceRequest = JSON.parse(String(putCall?.[1]?.body)) as { args: string[] };
    expect(serviceRequest.args[1]).toContain("exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080");
    expect(serviceRequest.args[1]).toContain("OPENAI_API_KEY='test'\\''value'");
  });

  it("optionally installs agents through npx when requested", async () => {
    const sprite = {
      name: "sprite-1",
      execFile: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    spritesMocks.createSprite.mockResolvedValue(sprite);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: { status: "stopped" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
      create: { name: "sprite-1" },
      env: { OPENAI_API_KEY: "test" },
      installAgents: ["claude", "codex"],
    });

    await provider.create();

    expect(sprite.execFile).toHaveBeenCalledWith("bash", ["-lc", "npx -y @sandbox-agent/cli@0.5.0-rc.2 install-agent claude"], {
      env: { OPENAI_API_KEY: "test" },
    });
    expect(sprite.execFile).toHaveBeenCalledWith("bash", ["-lc", "npx -y @sandbox-agent/cli@0.5.0-rc.2 install-agent codex"], {
      env: { OPENAI_API_KEY: "test" },
    });
  });

  it("returns the sprite URL and provider token for authenticated access", async () => {
    spritesMocks.getSprite.mockResolvedValue({
      name: "sprite-1",
      url: "https://sprite-1.sprites.app",
    });

    const provider = sprites({
      token: "sprite-token",
    });

    await expect(provider.getUrl?.("sprite-1")).resolves.toBe("https://sprite-1.sprites.app");
    await expect((provider as SandboxProvider & { getToken: (sandboxId: string) => Promise<string> }).getToken("sprite-1")).resolves.toBe("sprite-token");
  });

  it("maps missing reconnect targets to SandboxDestroyedError", async () => {
    spritesMocks.getSprite.mockRejectedValue(new Error("Sprite not found: missing-sprite"));
    const provider = sprites({
      token: "sprite-token",
    });

    await expect(provider.reconnect?.("missing-sprite")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it("skips starting the service when the desired service is already running", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cmd: "bash",
            args: ["-lc", "exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080"],
            http_port: 8080,
            state: { status: "running" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            cmd: "bash",
            args: ["-lc", "exec npx -y @sandbox-agent/cli@0.5.0-rc.2 server --no-token --host 0.0.0.0 --port 8080"],
            http_port: 8080,
            state: { status: "running" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = sprites({
      token: "sprite-token",
    });

    await provider.ensureServer?.("sprite-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});

describe("boxd provider", () => {
  function stubRunningMachine() {
    boxdMocks.create.mockResolvedValue({ id: "vm-1", name: "sandbox-1" });
    boxdMocks.waitUntilReady.mockResolvedValue({ id: "vm-1", status: "running" });
    boxdMocks.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, success: true });
  }

  it("creates a machine, pins the proxy port, stores the token and env, installs, and starts a token-protected server", async () => {
    stubRunningMachine();

    const provider = boxd({
      create: { name: "sandbox-1", labels: { team: "agents" }, deleteAfter: 3600 },
      env: { ANTHROPIC_API_KEY: "test'value" },
      token: "fixed-token",
    });

    await expect(provider.create()).resolves.toBe("vm-1");

    expect(boxdMocks.create).toHaveBeenCalledWith({ name: "sandbox-1", labels: { team: "agents" }, deleteAfter: 3600 });
    expect(boxdMocks.setPort).toHaveBeenCalledWith("vm-1", 3000);
    expect(boxdMocks.setBotProtection).toHaveBeenCalledWith("vm-1", "off");
    expect(boxdMocks.fsWrite).toHaveBeenCalledWith("vm-1", ".sandbox-agent-boxd/token", "fixed-token\n", { mode: 0o600 });
    expect(boxdMocks.fsWrite).toHaveBeenCalledWith("vm-1", ".sandbox-agent-boxd/env", "export ANTHROPIC_API_KEY='test'\\''value'\n", { mode: 0o600 });

    const commands = boxdMocks.exec.mock.calls.map(([, params]) => (params as { command: string[] }).command[2]);
    expect(commands[0]).toContain("releases.rivet.dev/sandbox-agent/0.5.0-rc.2/install.sh");
    expect(commands[0]).toContain("sandbox-agent install-agent 'claude'");
    expect(commands[0]).toContain("sandbox-agent install-agent 'codex'");
    expect(commands[1]).toContain("pkill -x sandbox-agent");
    expect(commands[1]).toContain('sandbox-agent server --token "$(cat ./.sandbox-agent-boxd/token)" --host 0.0.0.0 --port 3000');
    expect(commands.join("\n")).not.toContain("--no-token");
    expect(commands.join("\n")).not.toContain("test'value");
  });

  it("generates a random token per machine when none is configured", async () => {
    stubRunningMachine();
    const provider = boxd({ installAgents: [] }) as SandboxProvider & { getToken(id: string): Promise<string> };

    await provider.create();

    const tokenWrite = boxdMocks.fsWrite.mock.calls.find(([, path]) => path === ".sandbox-agent-boxd/token");
    const token = String(tokenWrite?.[2]).trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(provider.getToken("vm-1")).resolves.toBe(token);
    expect(boxdMocks.fsRead).not.toHaveBeenCalled();
  });

  it("reads the token back from the machine for a new provider instance", async () => {
    boxdMocks.fsRead.mockResolvedValue(new TextEncoder().encode("stored-token\n"));
    boxdMocks.get.mockResolvedValue({ id: "vm-1", access: { url: "https://sandbox-1.boxd.sh" } });
    const provider = boxd() as SandboxProvider & { getToken(id: string): Promise<string> };

    await expect(provider.getToken("vm-1")).resolves.toBe("stored-token");
    await expect(provider.getUrl?.("vm-1")).resolves.toBe("https://sandbox-1.boxd.sh");
    await expect(provider.getInspectorUrl?.("vm-1")).resolves.toBe("https://sandbox-1.boxd.sh/ui/?token=stored-token");
  });

  it("deletes the machine when setup fails after it was created", async () => {
    stubRunningMachine();
    boxdMocks.exec.mockResolvedValue({ stdout: "", stderr: "curl: (6) Could not resolve host", exitCode: 6, success: false });
    const provider = boxd();

    await expect(provider.create()).rejects.toThrow(/boxd command failed \(exit 6\)/);
    expect(boxdMocks.delete).toHaveBeenCalledWith("vm-1");
  });

  it("wakes, resumes, or starts a sleeping machine on reconnect", async () => {
    const provider = boxd();

    boxdMocks.get.mockResolvedValueOnce({ id: "vm-1", status: "hibernated" });
    await provider.reconnect?.("vm-1");
    expect(boxdMocks.wake).toHaveBeenCalledWith("vm-1");

    boxdMocks.get.mockResolvedValueOnce({ id: "vm-1", status: "suspended" });
    await provider.reconnect?.("vm-1");
    expect(boxdMocks.resume).toHaveBeenCalledWith("vm-1");

    boxdMocks.get.mockResolvedValueOnce({ id: "vm-1", status: "stopped" });
    await provider.reconnect?.("vm-1");
    expect(boxdMocks.start).toHaveBeenCalledWith("vm-1");

    boxdMocks.get.mockResolvedValueOnce({ id: "vm-1", status: "running" });
    await provider.reconnect?.("vm-1");
    expect(boxdMocks.waitUntilReady).toHaveBeenCalledTimes(4);
  });

  it("maps missing machines to SandboxDestroyedError", async () => {
    boxdMocks.get.mockRejectedValue(new boxdMocks.MockNotFoundError("VM not found"));
    const provider = boxd();

    await expect(provider.reconnect?.("vm-missing")).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it("hibernates on pause, deletes on destroy, and ignores machines that are already gone", async () => {
    const provider = boxd({ clientOptions: { apiKey: "test-key" } });

    await provider.pause?.("vm-1");
    expect(boxdMocks.hibernate).toHaveBeenCalledWith("vm-1");

    await provider.destroy("vm-1");
    expect(boxdMocks.delete).toHaveBeenCalledWith("vm-1");

    boxdMocks.delete.mockRejectedValueOnce(new boxdMocks.MockNotFoundError("VM not found"));
    await expect(provider.kill?.("vm-1")).resolves.toBeUndefined();
    expect(boxdMocks.clientOptions).toHaveBeenCalledTimes(1);
    expect(boxdMocks.clientOptions).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("restarts the server from the stored token and env in ensureServer", async () => {
    boxdMocks.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, success: true });
    const provider = boxd({ agentPort: 8080 });

    await provider.ensureServer?.("vm-1");

    expect(boxdMocks.exec).toHaveBeenCalledTimes(1);
    const command = (boxdMocks.exec.mock.calls[0]?.[1] as { command: string[] }).command;
    expect(command.slice(0, 2)).toEqual(["bash", "-lc"]);
    expect(command[2]).toContain(". ./.sandbox-agent-boxd/env");
    expect(command[2]).toContain("--port 8080");
    expect(command[2]).not.toContain("pkill");
  });
});
