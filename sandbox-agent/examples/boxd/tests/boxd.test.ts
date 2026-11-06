import { describe, it, expect } from "vitest";
import { SandboxAgent } from "sandbox-agent";
import { boxd } from "sandbox-agent/boxd";

const shouldRun = Boolean(process.env.BOXD_API_KEY);
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("boxd provider", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const env: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

      const sdk = await SandboxAgent.start({
        sandbox: boxd({
          env,
          create: { deleteAfter: 3600 },
        }),
      });

      try {
        const health = await sdk.getHealth();
        expect(health.status).toBe("ok");
      } finally {
        await sdk.destroySandbox();
      }
    },
    timeoutMs,
  );
});
