#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  authorizeDeepSeekHarness,
  logoutDeepSeekHarness,
  readHarnessCredentialStatus,
  readHarnessMemoryConnection,
} from "./device-auth.js";
import { createMemoryActions, startMemoryCenter } from "../scripts/memory_center.mjs";
import { readLocalProviderConfig, localProviderStageReady } from "./local-provider-config.ts";
import { FilePendingTurnQueue } from "./sdk/queue.ts";
import { resolveDshHome } from "./device-auth.js";
import { join } from "node:path";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runProviderSetup(filename = "provider_setup.mjs") {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const script = resolve(cliDirectory, "..", "scripts", filename);
  const forwarded = process.argv.slice(3);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...forwarded], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`TMCRA provider setup exited with ${signal || code || "an error"}.`));
    });
  });
}

export async function main() {
  const command = process.argv[2] || "help";
  const json = process.argv.includes("--json");
  const dshHome = option("--dsh-home");
  if (command === "local-install") {
    await runProviderSetup("local_setup.mjs");
    return;
  }
  if (command === "memory") {
    const connection = await readHarnessMemoryConnection(dshHome);
    const scope = option("--scope"); const sessionId = option("--session");
    if (!scope || !sessionId) throw new Error("Use memory --scope EXACT_PROJECT_SCOPE --session EXACT_SESSION_ID");
    const queue = new FilePendingTurnQueue(join(resolveDshHome(dshHome), "tmcra", "deepseek-harness-pending-turns.json"));
    const invoke = createMemoryActions({ config: connection, scope, sessionId, globalScope: connection.globalScope,
      status: async () => ({ pending: (await queue.list()).filter((row) => row.scopeName === scope).map((row) => ({ id: row.idempotencyKey, jobId: row.jobId, state: row.observedStatus || "queued" })) }),
      request: async (path, options) => {
        const provider = await readLocalProviderConfig().catch(() => null);
        const localHeaders: Record<string, string> = {};
        if (provider && localProviderStageReady(provider, "writer")) localHeaders["X-TMCRA-Writer-Execution"] = "user-provider";
        if (provider && localProviderStageReady(provider, "organizer")) localHeaders["X-TMCRA-Organizer-Execution"] = "user-provider";
        const response = await fetch(`${connection.baseUrl.replace(/\/+$/u, "")}${path}`, { method: options.method,
          headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json",
            "X-TMCRA-Client-Platform": "deepseek_harness", "X-TMCRA-Integration-ID": "tmcra-deepseek-harness", ...localHeaders, ...options.headers },
          body: JSON.stringify(options.body), signal: AbortSignal.timeout(30000), redirect: "error" });
        if (!response.ok) throw new Error(`TMCRA request failed (${response.status}); check authorization and service version`);
        return response.json();
      },
    });
    const center = await startMemoryCenter({ invoke, open: !process.argv.includes("--no-open") });
    printJson({ url: center.url, credentialsLocalOnly: true });
    await new Promise<void>((done) => center.server.once("close", done));
    return;
  }
  if (command === "setup" || command === "configure-models") {
    await runProviderSetup();
    return;
  }
  if (command === "login") {
    const result = await authorizeDeepSeekHarness({
      dshHome,
      authBaseUrl: option("--auth-base-url"),
      noOpen: process.argv.includes("--no-open"),
      onProgress: (event) => {
        if (json) return;
        if (event.type === "authorization") {
          process.stderr.write(`TMCRA authorization code: ${event.userCode}\n`);
          process.stderr.write(`Open: ${event.verificationUrl}\n`);
        } else if (event.type === "waiting") {
          process.stderr.write("Waiting for approval in your TMCRA account...\n");
        } else if (event.type === "network_retry") {
          process.stderr.write("TMCRA authorization network retry in progress...\n");
        }
      },
    });
    if (json) printJson({ ok: true, ...result });
    else process.stdout.write(`TMCRA is connected. Harness credentials were saved to ${result.credentialsPath}.\n`);
    return;
  }
  if (command === "status") {
    const status = await readHarnessCredentialStatus(dshHome);
    if (json) printJson({ ok: true, ...status });
    else process.stdout.write(status.configured
      ? `TMCRA is configured in ${status.credentialsPath}.\n`
      : `TMCRA is not configured. Run: dsh-tmcra-memory login\n`);
    return;
  }
  if (command === "logout") {
    const path = await logoutDeepSeekHarness(dshHome);
    if (json) printJson({ ok: true, configured: false, credentialsPath: path });
    else process.stdout.write(`TMCRA credentials were removed from ${path}. Revoke the connection in your TMCRA account if this device is no longer trusted.\n`);
    return;
  }
  process.stdout.write(`Usage:\n  dsh-tmcra-memory local-install [--no-open]\n  dsh-tmcra-memory setup [--no-open] [--config-file PATH] [--json]\n  dsh-tmcra-memory memory --scope EXACT_PROJECT_SCOPE --session EXACT_SESSION_ID [--no-open] [--dsh-home PATH]\n  dsh-tmcra-memory login [--no-open] [--auth-base-url URL] [--dsh-home PATH] [--json]\n  dsh-tmcra-memory status [--dsh-home PATH] [--json]\n  dsh-tmcra-memory logout [--dsh-home PATH] [--json]\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "TMCRA login failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
