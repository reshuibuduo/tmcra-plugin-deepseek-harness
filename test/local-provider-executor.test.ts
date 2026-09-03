import { describe, expect, it } from "vitest";
import {
  executeAvailableLocalProviderTasks,
  runLocalProviderExecutor,
  type LocalProviderTaskClient,
} from "../src/local-provider-executor.ts";
import type { LocalProviderConfig } from "../src/local-provider-config.ts";
import { TMCRAClient } from "../src/sdk/client.ts";
import type {
  UserProviderTaskClaim,
  UserProviderTaskCompletion,
  UserProviderTaskFailure,
  UserProviderTaskLease,
  UserProviderTaskStage,
  UserProviderTaskStatus,
} from "../src/sdk/models.ts";

const providerConfig: LocalProviderConfig = {
  schemaVersion: 1,
  execution: "local",
  writer: {
    provider: "deepseek",
    baseUrl: "https://provider.example/v1",
    model: "writer-model",
    apiKey: "provider-secret",
  },
  organizer: {
    inheritWriter: false,
    provider: "openai-compatible",
    baseUrl: "https://organizer.example/v1",
    model: "organizer-model",
    apiKey: "organizer-secret",
  },
  updatedAt: "2026-09-04T00:00:00.000Z",
};

function task(stage: UserProviderTaskStage, sequence: number): UserProviderTaskLease {
  return {
    schema_version: "tmcra.user-provider-task.1",
    task_id: `${stage}-task-${sequence}`,
    stage,
    operation: stage === "writer" ? "writer.batch" : "slow_graph.flash",
    request_sha256: "a".repeat(64),
    request: {
      schema_version: "tmcra.openai-compatible-request.1",
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: `${stage} payload` },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_schema", json_schema: { name: "result" } },
    },
    lease_token: `${stage}-lease-${"x".repeat(40)}`,
    lease_expires_at: Date.now() / 1_000 + 240,
  };
}

function status(taskId: string, state: UserProviderTaskStatus["state"]): UserProviderTaskStatus {
  return { task_id: taskId, state, lease_expires_at: null, idempotent_replay: false };
}

class FakeTaskClient implements LocalProviderTaskClient {
  readonly queued = new Map<UserProviderTaskStage, UserProviderTaskLease[]>([
    ["writer", [task("writer", 1)]],
    ["organizer", [task("organizer", 1)]],
  ]);
  readonly claims: UserProviderTaskStage[] = [];
  readonly started: string[] = [];
  readonly completed: Array<{ taskId: string; body: UserProviderTaskCompletion }> = [];
  readonly failed: Array<{ taskId: string; body: UserProviderTaskFailure }> = [];

  async claimUserProviderTask(stage: UserProviderTaskStage): Promise<UserProviderTaskClaim> {
    this.claims.push(stage);
    return { task: this.queued.get(stage)?.shift() ?? null, retry_after_seconds: 0 };
  }

  async startUserProviderTask(taskId: string): Promise<UserProviderTaskStatus> {
    this.started.push(taskId);
    return status(taskId, "running");
  }

  async heartbeatUserProviderTask(taskId: string): Promise<UserProviderTaskStatus> {
    return status(taskId, "running");
  }

  async completeUserProviderTask(
    taskId: string,
    body: UserProviderTaskCompletion,
  ): Promise<UserProviderTaskStatus> {
    this.completed.push({ taskId, body });
    return status(taskId, "completed");
  }

  async failUserProviderTask(
    taskId: string,
    body: UserProviderTaskFailure,
  ): Promise<UserProviderTaskStatus> {
    this.failed.push({ taskId, body });
    return status(taskId, body.outcome);
  }
}

describe("local provider executor", () => {
  it("executes Writer and organizer fairly while keeping provider credentials local", async () => {
    const client = new FakeTaskClient();
    const providerCalls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      providerCalls.push({ url: String(input), headers: new Headers(init?.headers), body });
      const model = String(body.model);
      return new Response(JSON.stringify({
        id: `raw-${model}`,
        raw_provider_envelope_marker: "must-not-return-to-tmcra",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ model, accepted: true }) } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await executeAvailableLocalProviderTasks({
      client,
      providerConfig,
      fetchImpl,
      maxTasks: 4,
    });

    expect(result).toEqual({ executed: 2 });
    expect(client.started).toEqual(["writer-task-1", "organizer-task-1"]);
    expect(client.completed).toHaveLength(2);
    expect(client.failed).toHaveLength(0);
    expect(providerCalls.map((call) => call.url)).toEqual([
      "https://provider.example/v1/chat/completions",
      "https://organizer.example/v1/chat/completions",
    ]);
    expect(providerCalls[0]!.headers.get("authorization")).toBe("Bearer provider-secret");
    expect(providerCalls[1]!.headers.get("authorization")).toBe("Bearer organizer-secret");
    expect(providerCalls[0]!.body).toMatchObject({
      model: "writer-model",
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      enable_thinking: false,
    });
    expect(providerCalls[1]!.body).toMatchObject({
      model: "organizer-model",
      response_format: { type: "json_schema" },
    });
    for (const completion of client.completed) {
      expect(completion.body.usage).toEqual({
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cache_hit_tokens: 3,
        cache_miss_tokens: 7,
      });
      const serialized = JSON.stringify(completion.body);
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("organizer-secret");
      expect(serialized).not.toContain("must-not-return-to-tmcra");
      expect(completion.body.provider_request_id).toMatch(/^raw-(writer|organizer)-model$/u);
    }
    expect(client.claims.slice(0, 2)).toEqual(["writer", "organizer"]);
  });

  it("records an unresolved provider transport outcome without exposing the error", async () => {
    const client = new FakeTaskClient();
    client.queued.set("organizer", []);
    await executeAvailableLocalProviderTasks({
      client,
      providerConfig,
      maxTasks: 1,
      fetchImpl: async () => { throw new Error("transport included provider-secret"); },
    });
    expect(client.completed).toHaveLength(0);
    expect(client.failed).toEqual([{
      taskId: "writer-task-1",
      body: {
        lease_token: `writer-lease-${"x".repeat(40)}`,
        provider: "deepseek",
        model: "writer-model",
        outcome: "unknown",
        error_code: "provider_transport_error",
      },
    }]);
    expect(JSON.stringify(client.failed)).not.toContain("provider-secret");
  });

  it("stays idle without resolving TMCRA credentials when no provider is configured", async () => {
    const controller = new AbortController();
    let clientFactoryCalls = 0;
    const running = runLocalProviderExecutor({
      signal: controller.signal,
      idleMs: 5,
      readConfig: async () => null,
      clientFactory: async () => {
        clientFactoryCalls += 1;
        return new FakeTaskClient();
      },
    });
    setTimeout(() => controller.abort(), 20);
    await running;
    expect(clientFactoryCalls).toBe(0);
  });
});

describe("TMCRAClient local execution routing", () => {
  it("adds only the stage headers required by ingest and consolidation", async () => {
    const calls: Array<{ path: string; headers: Headers }> = [];
    const client = new TMCRAClient({
      baseUrl: "https://memory.example",
      apiKey: "tmcra-key",
      retry: { maxAttempts: 1 },
      localProviderExecution: { writer: true, organizer: true },
      fetch: async (input, init) => {
        calls.push({ path: new URL(String(input)).pathname, headers: new Headers(init?.headers) });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.ingest("project-scope", {
      session_id: "session-1",
      messages: [{ message_id: "message-1", role: "user", content: "hello", timestamp: new Date(0) }],
    });
    await client.consolidate("project-scope");

    expect(calls[0]!.headers.get("x-tmcra-writer-execution")).toBe("user-provider");
    expect(calls[0]!.headers.get("x-tmcra-organizer-execution")).toBe("user-provider");
    expect(calls[1]!.headers.get("x-tmcra-writer-execution")).toBeNull();
    expect(calls[1]!.headers.get("x-tmcra-organizer-execution")).toBe("user-provider");
  });
});
