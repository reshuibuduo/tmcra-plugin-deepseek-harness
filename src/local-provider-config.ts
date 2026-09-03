import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type LocalProviderKind = "deepseek" | "openai-compatible" | "local-openai-compatible";
export type LocalProviderStageName = "writer" | "organizer";

export interface LocalProviderStage {
  provider: LocalProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LocalProviderConfig {
  schemaVersion: 1;
  execution: "local";
  writer: LocalProviderStage;
  organizer: { inheritWriter: true } | ({ inheritWriter: false } & LocalProviderStage);
  updatedAt: string;
}

const PROVIDERS = new Set<LocalProviderKind>([
  "deepseek",
  "openai-compatible",
  "local-openai-compatible",
]);
const MAX_TEXT_LENGTH = 512;
const MAX_SECRET_LENGTH = 4_096;

export function resolveLocalProviderConfigPath(
  value = process.env.TMCRA_LOCAL_PROVIDER_CONFIG,
): string {
  return resolve(value?.trim() || join(homedir(), ".config", "tmcra", "local-providers.json"));
}

function boundedText(value: unknown, field: string, maximum = MAX_TEXT_LENGTH): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`tmcra-memory: ${field} is invalid`);
  }
  return normalized;
}

function loopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

function providerBaseUrl(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`tmcra-memory: ${field} must be a valid URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`tmcra-memory: ${field} contains unsupported URL components`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHost(parsed.hostname))) {
    throw new Error(`tmcra-memory: ${field} must use HTTPS; loopback may use HTTP`);
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function providerStage(value: unknown, field: string): LocalProviderStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tmcra-memory: ${field} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const provider = boundedText(input.provider, `${field} provider`) as LocalProviderKind;
  if (!PROVIDERS.has(provider)) throw new Error(`tmcra-memory: ${field} provider is unsupported`);
  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey.length > MAX_SECRET_LENGTH || /[\r\n\0]/u.test(apiKey)) {
    throw new Error(`tmcra-memory: ${field} API key is invalid`);
  }
  return {
    provider,
    baseUrl: providerBaseUrl(input.baseUrl, `${field} base URL`),
    model: boundedText(input.model, `${field} model`),
    ...(apiKey ? { apiKey } : {}),
  };
}

function validateStoredConfig(value: unknown): LocalProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tmcra-memory: local provider configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || input.execution !== "local") {
    throw new Error("tmcra-memory: local provider configuration version is unsupported");
  }
  const writer = providerStage(input.writer, "writer");
  if (!input.organizer || typeof input.organizer !== "object" || Array.isArray(input.organizer)) {
    throw new Error("tmcra-memory: organizer configuration must be an object");
  }
  const organizerInput = input.organizer as Record<string, unknown>;
  const organizer = organizerInput.inheritWriter !== false
    ? { inheritWriter: true as const }
    : { inheritWriter: false as const, ...providerStage(organizerInput, "organizer") };
  const updatedAt = boundedText(input.updatedAt, "provider updatedAt", 64);
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("tmcra-memory: provider updatedAt must be an ISO timestamp");
  }
  return {
    schemaVersion: 1,
    execution: "local",
    writer,
    organizer,
    updatedAt,
  };
}

export async function readLocalProviderConfig(
  path = resolveLocalProviderConfigPath(),
): Promise<LocalProviderConfig | null> {
  if (!existsSync(path)) return null;
  return validateStoredConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function resolvedLocalProviderStage(
  config: LocalProviderConfig,
  stage: LocalProviderStageName,
): LocalProviderStage {
  if (stage === "writer") return config.writer;
  return config.organizer.inheritWriter ? config.writer : config.organizer;
}

export function localProviderStageReady(
  config: LocalProviderConfig,
  stage: LocalProviderStageName,
): boolean {
  const target = resolvedLocalProviderStage(config, stage);
  return Boolean(target.apiKey) || loopbackHost(new URL(target.baseUrl).hostname);
}
