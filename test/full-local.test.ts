import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFullLocalConfig } from "../src/full-local-config.js";
import { readLocalProviderConfig } from "../src/local-provider-config.js";
import { readHarnessMemoryConnection } from "../src/device-auth.js";

afterEach(() => vi.unstubAllEnvs());
test("full local binding works without DSH cloud login and disables cloud model executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmcra-dsh-local-"));
  try {
    const path = join(root, "client.json");
    await writeFile(path, JSON.stringify({ deploymentMode: "local", baseUrl: "http://127.0.0.1:2009",
      apiKey: "synthetic-local-key", globalScope: "local-global", projectScopePrefix: "local-project" }), "utf8");
    vi.stubEnv("TMCRA_CONFIG_FILE", path);
    vi.stubEnv("TMCRA_API_KEY", "synthetic-cloud-key");
    expect((await readHarnessMemoryConnection(root)).apiKey).toBe("synthetic-local-key");
    expect(await readLocalProviderConfig()).toBeNull();
    vi.stubEnv("TMCRA_CONFIG_FILE", "");
    vi.stubEnv("TMCRA_LOCAL_BINDING_FILE", join(root, "local-memory.json"));
    const secrets = join(root, "state/lite-cpu/secrets");
    await mkdir(secrets, { recursive: true });
    await writeFile(process.env.TMCRA_LOCAL_BINDING_FILE!, JSON.stringify({ schemaVersion: 1, mode: "local", dataRoot: root, profile: "lite-cpu" }), "utf8");
    await expect(readHarnessMemoryConnection(root)).rejects.toThrow();
    await copyFile(path, join(secrets, "client-plugin.json"));
    expect((await readHarnessMemoryConnection(root)).apiKey).toBe("synthetic-local-key");
    expect(await readLocalProviderConfig()).toBeNull();
    vi.stubEnv("TMCRA_CONFIG_FILE", path);
    await writeFile(path, JSON.stringify({ deploymentMode: "local", baseUrl: "https://example.invalid" }), "utf8");
    await expect(readFullLocalConfig()).rejects.toThrow("numeric loopback");
  } finally { await rm(root, { recursive: true, force: true }); }
});
