import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "tmcra-dsh-cli-"));
const secret = "isolated-cli-auth-test";
const child = spawn(process.execPath, ["dist/cli.mjs", "memory", "--scope", "test-project", "--session", "test-session", "--no-open", "--dsh-home", root], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMCRA_API_KEY: secret, TMCRA_API_BASE_URL: "https://example.invalid", TMCRA_MEMORY_STATE_DIR: join(root, "controls") },
});
let stdout = "", stderr = "";
const exited = new Promise((resolve) => child.once("exit", resolve));
try {
  const launch = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`memory CLI did not start: ${stderr}`)), 10000);
    child.on("error", reject);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } } });
    child.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error(stderr)); });
  });
  const url = new URL(launch.url);
  const request = async (action, args = {}) => {
    const response = await fetch(`${url.origin}/api/action`, { method: "POST", headers: { "Content-Type": "application/json", "X-TMCRA-Token": url.hash.slice(1) }, body: JSON.stringify({ action, args }) });
    assert.equal(response.status, 200); return response.json();
  };
  const data = await request("dashboard");
  assert.equal(data.result.scope, "test-project");
  await request("mode", { mode: "off" });
  assert.equal((await request("dashboard")).result.policy.read, false);
  const page = await fetch(url.origin);
  assert.match(await page.text(), /记忆工作台/u);
  await request("close");
  assert.equal(await exited, 0);
  assert(!stdout.includes(secret)); assert(!stderr.includes(secret));
  console.log(JSON.stringify({ ok: true, builtCli: true, panelResources: true, modes: true, credentialSafe: true }));
} finally {
  child.kill(); await exited;
  await rm(root, { recursive: true, force: true });
}
