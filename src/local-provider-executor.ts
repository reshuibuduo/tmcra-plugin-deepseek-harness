import { createHash } from "node:crypto";
import type { FetchLike, RequestOptions } from "./sdk/client.ts";
import type {
  JsonValue,
  UserProviderTaskClaim,
  UserProviderTaskCompletion,
  UserProviderTaskFailure,
  UserProviderTaskLease,
  UserProviderTaskStage,
  UserProviderTaskStatus,
  UserProviderUsage,
} from "./sdk/models.ts";
import {
  localProviderStageReady,
  readLocalProviderConfig,
  resolvedLocalProviderStage,
  type LocalProviderConfig,
  type LocalProviderStage,
} from "./local-provider-config.ts";

const TASK_SCHEMA_VERSION = "tmcra.user-provider-task.1";
const REQUEST_SCHEMA_VERSION = "tmcra.openai-compatible-request.1";
const STAGES: readonly UserProviderTaskStage[] = ["writer", "organizer"];
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TASK_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_IDLE_MS = 1_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 180_000;

export interface LocalProviderTaskClient {
  claimUserProviderTask(stage: UserProviderTaskStage, options?: RequestOptions): Promise<UserProviderTaskClaim>;
  startUserProviderTask(taskId: string, leaseToken: string, options?: RequestOptions): Promise<UserProviderTaskStatus>;
  heartbeatUserProviderTask(taskId: string, leaseToken: string, options?: RequestOptions): Promise<UserProviderTaskStatus>;
  completeUserProviderTask(
    taskId: string,
    body: UserProviderTaskCompletion,
    options?: RequestOptions,
  ): Promise<UserProviderTaskStatus>;
  failUserProviderTask(
    taskId: string,
    body: UserProviderTaskFailure,
    options?: RequestOptions,
  ): Promise<UserProviderTaskStatus>;
}

export interface LocalProviderExecutorEvent {
  kind: "completed" | "failed" | "waiting";
  stage?: UserProviderTaskStage;
  taskId?: string;
  operation?: string;
  provider?: string;
  model?: string;
  outcome?: "failed" | "unknown";
  code?: string;
  requestSha256?: string;
  responseSha256?: string;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\r\n\0]/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function validateTask(task: unknown, expectedStage: UserProviderTaskStage): UserProviderTaskLease {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("provider task must be an object");
  }
  const input = task as Record<string, unknown>;
  if (input.schema_version !== TASK_SCHEMA_VERSION || input.stage !== expectedStage) {
    throw new Error("provider task contract is unsupported");
  }
  const taskId = boundedString(input.task_id, "provider task ID", 200);
  const leaseToken = boundedString(input.lease_token, "provider task lease", 256);
  if (leaseToken.length < 32) throw new Error("provider task lease is invalid");
  const requestSha256 = boundedString(input.request_sha256, "provider request digest", 64);
  if (!/^[0-9a-f]{64}$/u.test(requestSha256)) throw new Error("provider request digest is invalid");
  const operation = boundedString(input.operation, "provider task operation", 80);
  const modelRequest = input.request;
  if (!modelRequest || typeof modelRequest !== "object" || Array.isArray(modelRequest)) {
    throw new Error("provider model request is invalid");
  }
  const request = modelRequest as Record<string, unknown>;
  const allowed = new Set(["schema_version", "messages", "temperature", "max_tokens", "response_format"]);
  if (
    request.schema_version !== REQUEST_SCHEMA_VERSION ||
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !Array.isArray(request.messages) ||
    request.messages.length < 2 ||
    request.messages.length > 64
  ) {
    throw new Error("provider model request contract is invalid");
  }
  const messages = request.messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("provider message is invalid");
    }
    const item = message as Record<string, unknown>;
    const role = String(item.role ?? "");
    if (!new Set(["system", "user", "assistant"]).has(role)) {
      throw new Error("provider message role is invalid");
    }
    if (typeof item.content !== "string" || item.content.length > 8_000_000) {
      throw new Error("provider message content is invalid");
    }
    return { role: role as "system" | "user" | "assistant", content: item.content };
  });
  const maxTokens = Number(request.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072) {
    throw new Error("provider max_tokens is invalid");
  }
  if (request.temperature !== 0) throw new Error("provider temperature contract is invalid");
  const responseFormat = request.response_format;
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    throw new Error("provider response format is invalid");
  }
  const responseFormatType = (responseFormat as Record<string, unknown>).type;
  if (responseFormatType !== "json_object" && responseFormatType !== "json_schema") {
    throw new Error("provider response format is unsupported");
  }
  const leaseExpiresAt = Number(input.lease_expires_at);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt < 0) {
    throw new Error("provider task lease expiry is invalid");
  }
  return {
    schema_version: TASK_SCHEMA_VERSION,
    task_id: taskId,
    stage: expectedStage,
    operation,
    request_sha256: requestSha256,
    request: {
      schema_version: REQUEST_SCHEMA_VERSION,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: responseFormat as Record<string, JsonValue>,
    },
    lease_token: leaseToken,
    lease_expires_at: leaseExpiresAt,
  };
}

function usageCount(value: Record<string, unknown>, ...names: string[]): number | null {
  const found = names.map((name) => value[name]).find((item) => item !== undefined);
  if (found === undefined) return null;
  const number = Number(found);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeUsage(value: unknown): UserProviderUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const input = usageCount(usage, "prompt_tokens", "input_tokens");
  const output = usageCount(usage, "completion_tokens", "output_tokens");
  if (input === null || output === null) return null;
  const details = usage.prompt_tokens_details;
  const cachedFromDetails = details && typeof details === "object" && !Array.isArray(details)
    ? usageCount(details as Record<string, unknown>, "cached_tokens")
    : null;
  const hit = usageCount(usage, "prompt_cache_hit_tokens", "cache_read_input_tokens", "cached_tokens")
    ?? cachedFromDetails;
  const miss = usageCount(usage, "prompt_cache_miss_tokens", "cache_miss_input_tokens");
  const normalizedHit = hit ?? (miss === null ? 0 : input - miss);
  const normalizedMiss = miss ?? input - normalizedHit;
  if (normalizedHit < 0 || normalizedMiss < 0 || normalizedHit + normalizedMiss !== input) return null;
  const total = usageCount(usage, "total_tokens") ?? input + output;
  if (total < input + output) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_hit_tokens: normalizedHit,
    cache_miss_tokens: normalizedMiss,
  };
}

class ProviderExecutionError extends Error {
  readonly code: string;
  readonly outcome: "failed" | "unknown";
  readonly providerRequestId: string | null;

  constructor(
    message: string,
    options: { code?: string; outcome?: "failed" | "unknown"; providerRequestId?: string | null } = {},
  ) {
    super(message);
    this.name = "ProviderExecutionError";
    this.code = options.code ?? "provider_execution_failed";
    this.outcome = options.outcome ?? "failed";
    this.providerRequestId = options.providerRequestId ?? null;
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ProviderExecutionError("provider response is too large", { code: "provider_response_too_large" });
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new ProviderExecutionError("provider response is too large", { code: "provider_response_too_large" });
    }
    return text;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderExecutionError("provider response is too large", { code: "provider_response_too_large" });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function providerCompletion(
  target: LocalProviderStage,
  task: UserProviderTaskLease,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<{
  output: Record<string, JsonValue>;
  usage: UserProviderUsage | null;
  providerRequestId: string | null;
  responseSha256: string;
}> {
  const configuredTimeout = Number(process.env.TMCRA_LOCAL_PROVIDER_TIMEOUT_MS || DEFAULT_PROVIDER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1_000, Math.min(15 * 60 * 1_000, configuredTimeout))
    : DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
  timeout.unref?.();
  try {
    const body: Record<string, unknown> = { ...task.request, model: target.model };
    if (target.provider === "deepseek") {
      if ((body.response_format as Record<string, unknown> | undefined)?.type === "json_schema") {
        body.response_format = { type: "json_object" };
      }
      body.thinking = { type: "disabled" };
      body.enable_thinking = false;
    }
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${target.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        },
        redirect: "error",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderExecutionError("provider transport outcome is unresolved", {
        code: error instanceof Error && error.name === "AbortError" ? "provider_timeout" : "provider_transport_error",
        outcome: "unknown",
      });
    }
    let text: string;
    try {
      text = await boundedResponseText(response);
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw new ProviderExecutionError("provider response outcome is unresolved", {
        code: error instanceof Error && error.name === "AbortError" ? "provider_timeout" : "provider_response_error",
        outcome: "unknown",
      });
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = text ? JSON.parse(text) as unknown : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new ProviderExecutionError("provider returned non-JSON HTTP content", {
        code: "provider_invalid_http_json",
      });
    }
    const providerRequestId = typeof payload.id === "string" ? payload.id.slice(0, 200) : null;
    if (!response.ok) {
      throw new ProviderExecutionError(`provider returned HTTP ${response.status}`, {
        code: `provider_http_${response.status}`,
        outcome: response.status >= 500 || [408, 425].includes(response.status) ? "unknown" : "failed",
        providerRequestId,
      });
    }
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw new ProviderExecutionError("provider response choice count is invalid", {
        code: "provider_invalid_choices",
        providerRequestId,
      });
    }
    const choice = choices[0];
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      throw new ProviderExecutionError("provider choice is invalid", {
        code: "provider_invalid_choice",
        providerRequestId,
      });
    }
    const choiceRecord = choice as Record<string, unknown>;
    if (choiceRecord.finish_reason !== "stop") {
      throw new ProviderExecutionError("provider response did not finish cleanly", {
        code: "provider_incomplete_response",
        providerRequestId,
      });
    }
    const message = choiceRecord.message;
    const content = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).content
      : undefined;
    let output: unknown;
    try {
      output = typeof content === "string" ? JSON.parse(content) as unknown : content;
    } catch {
      throw new ProviderExecutionError("provider completion is not valid JSON", {
        code: "provider_invalid_completion_json",
        providerRequestId,
      });
    }
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      throw new ProviderExecutionError("provider completion must be one JSON object", {
        code: "provider_completion_not_object",
        providerRequestId,
      });
    }
    const serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_OUTPUT_BYTES) {
      throw new ProviderExecutionError("provider completion is too large", {
        code: "provider_completion_too_large",
        providerRequestId,
      });
    }
    return {
      output: output as Record<string, JsonValue>,
      usage: normalizeUsage(payload.usage),
      providerRequestId,
      responseSha256: createHash("sha256").update(serialized).digest("hex"),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function executeTask(
  stage: UserProviderTaskStage,
  rawTask: unknown,
  target: LocalProviderStage,
  client: LocalProviderTaskClient,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    onEvent?: (event: LocalProviderExecutorEvent) => void;
  },
): Promise<void> {
  const task = validateTask(rawTask, stage);
  await client.startUserProviderTask(task.task_id, task.lease_token, { signal: options.signal });
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || options.signal?.aborted) return;
    heartbeatInFlight = true;
    void client.heartbeatUserProviderTask(task.task_id, task.lease_token, { signal: options.signal, retry: false })
      .catch(() => undefined)
      .finally(() => { heartbeatInFlight = false; });
  }, 30_000);
  heartbeat.unref?.();
  try {
    const result = await providerCompletion(target, task, options);
    await client.completeUserProviderTask(task.task_id, {
      lease_token: task.lease_token,
      provider: target.provider,
      model: target.model,
      output: result.output,
      usage: result.usage,
      provider_request_id: result.providerRequestId,
    }, { signal: options.signal });
    options.onEvent?.({
      kind: "completed",
      taskId: task.task_id,
      stage,
      operation: task.operation,
      provider: target.provider,
      model: target.model,
      requestSha256: task.request_sha256,
      responseSha256: result.responseSha256,
    });
  } catch (error) {
    if (!(error instanceof ProviderExecutionError)) throw error;
    await client.failUserProviderTask(task.task_id, {
      lease_token: task.lease_token,
      provider: target.provider,
      model: target.model,
      outcome: error.outcome,
      error_code: error.code,
    }, { signal: options.signal });
    options.onEvent?.({
      kind: "failed",
      taskId: task.task_id,
      stage,
      operation: task.operation,
      provider: target.provider,
      model: target.model,
      outcome: error.outcome,
      code: error.code,
      requestSha256: task.request_sha256,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export async function executeAvailableLocalProviderTasks(options: {
  client: LocalProviderTaskClient;
  providerConfig: LocalProviderConfig;
  maxTasks?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onEvent?: (event: LocalProviderExecutorEvent) => void;
}): Promise<{ executed: number }> {
  const maxTasks = options.maxTasks ?? 8;
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100) {
    throw new RangeError("maxTasks must be an integer from 1 through 100");
  }
  let executed = 0;
  let stageCursor = 0;
  for (let index = 0; index < maxTasks && !options.signal?.aborted; index += 1) {
    let claimed = false;
    for (let offset = 0; offset < STAGES.length; offset += 1) {
      const stageIndex = (stageCursor + offset) % STAGES.length;
      const stage = STAGES[stageIndex]!;
      if (!localProviderStageReady(options.providerConfig, stage)) continue;
      const response = await options.client.claimUserProviderTask(stage, {
        signal: options.signal,
        retry: false,
      });
      if (!response.task) continue;
      claimed = true;
      stageCursor = (stageIndex + 1) % STAGES.length;
      await executeTask(
        stage,
        response.task,
        resolvedLocalProviderStage(options.providerConfig, stage),
        options.client,
        options,
      );
      executed += 1;
      break;
    }
    if (!claimed) break;
  }
  return { executed };
}

export async function runLocalProviderExecutor(options: {
  clientFactory: () => Promise<LocalProviderTaskClient>;
  readConfig?: () => Promise<LocalProviderConfig | null>;
  signal?: AbortSignal;
  idleMs?: number;
  onEvent?: (event: LocalProviderExecutorEvent) => void;
}): Promise<void> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let failureDelay = idleMs;
  let lastFailure = "";
  while (!options.signal?.aborted) {
    try {
      const providerConfig = await (options.readConfig ?? readLocalProviderConfig)();
      if (!providerConfig || !STAGES.some((stage) => localProviderStageReady(providerConfig, stage))) {
        failureDelay = idleMs;
        lastFailure = "";
        await delay(idleMs, options.signal);
        continue;
      }
      const client = await options.clientFactory();
      const result = await executeAvailableLocalProviderTasks({
        client,
        providerConfig,
        maxTasks: 8,
        signal: options.signal,
        onEvent: options.onEvent,
      });
      failureDelay = idleMs;
      lastFailure = "";
      if (result.executed > 0) continue;
      await delay(idleMs, options.signal);
    } catch (error) {
      if (options.signal?.aborted) break;
      const code = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      if (code !== lastFailure) {
        options.onEvent?.({ kind: "waiting", code: code.slice(0, 160) });
        lastFailure = code;
      }
      await delay(failureDelay, options.signal);
      failureDelay = Math.min(30_000, Math.max(idleMs, failureDelay * 2));
    }
  }
}

export const localProviderExecutorTesting = Object.freeze({
  normalizeUsage,
  providerCompletion,
  validateTask,
});
