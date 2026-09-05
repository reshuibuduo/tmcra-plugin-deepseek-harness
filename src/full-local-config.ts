import { readFile } from "node:fs/promises";
import { activeLocalConfigPath, assertActiveMemoryConnection } from "../scripts/local_binding.mjs";

export function memoryFetch(connection: { baseUrl: string; apiKey: string }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    await assertActiveMemoryConnection(connection);
    return fetch(input, { ...init, redirect: "error" });
  };
}

export async function readFullLocalConfig() {
  const path = process.env.TMCRA_CONFIG_FILE || await activeLocalConfigPath();
  if (!path) return null;
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (value.deploymentMode !== "local") return null;
  const url = new URL(String(value.baseUrl || ""));
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Full-local memory requires a numeric loopback service URL");
  for (const key of ["apiKey", "globalScope", "projectScopePrefix"])
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Missing local binding field: ${key}`);
  return { baseUrl: url.toString().replace(/\/$/u, ""), apiKey: value.apiKey as string,
    globalScope: value.globalScope as string, projectScopePrefix: value.projectScopePrefix as string,
    deploymentMode: "local" as const };
}
