import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const dshEntry = join(dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
const npmEntry = process.env.npm_execpath;
const expectedDshVersion = "0.1.1-rc.2";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status}): ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a DSH compatibility-test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForWeb(port, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH Web exited before readiness (${child.exitCode}).\n${output.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`DSH Web did not become ready.\n${output.join("")}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-tmcra-compat-"));
const dshHome = join(temporaryRoot, "home");
const packageDir = join(temporaryRoot, "package");
let child;

try {
  const version = run(process.execPath, [dshEntry, "--version"]);
  if (version !== expectedDshVersion) {
    throw new Error(`Expected DSH ${expectedDshVersion}, received ${version}.`);
  }
  if (!npmEntry) throw new Error("npm_execpath is required; run this probe through npm run test:dsh-compat.");

  await mkdir(packageDir, { recursive: true });
  const archiveName = run(process.execPath, [npmEntry, "pack", "--pack-destination", packageDir, "--silent"])
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  if (!archiveName) throw new Error("npm pack did not return an archive name.");
  // npm prints only the archive name on Unix and an absolute path on Windows.
  // resolve handles both forms; path.join would duplicate the Windows drive
  // path under packageDir and produce an invalid pnpm spec.
  const archivePath = resolve(packageDir, archiveName);
  const archiveSpec = archivePath;
  run(process.execPath, [join(root, "scripts", "canonicalize-tarball.mjs"), archivePath]);

  const env = { ...process.env, DSH_HOME: dshHome };
  run(process.execPath, [dshEntry, "plugin", "--profile", "web", "add", archiveSpec], { env });
  const dump = run(process.execPath, [dshEntry, "--profile", "web", "--dump-config"], { env });
  if (!/^\s*- id: tmcra-memory\s*$/m.test(dump) || !/^\s*name: dsh-tmcra-memory\s*$/m.test(dump)) {
    throw new Error("The composed DSH profile does not contain the TMCRA plugin entry.");
  }

  const profile = JSON.parse(await readFile(join(dshHome, "profiles", "web", "package.json"), "utf8"));
  const bundles = profile?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes("dsh-tmcra-memory")) {
    throw new Error("DSH installed the package but did not activate its bundle layer.");
  }

  const port = await freePort();
  const output = [];
  child = spawn(process.execPath, [
    dshEntry,
    "web",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--trusted-host", "127.0.0.1",
    "--no-open",
  ], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForWeb(port, child, output);

  console.log(`DSH ${version} package install, profile composition, and Web boot passed.`);
} finally {
  if (child) await stopProcess(child);
  await rm(temporaryRoot, { recursive: true, force: true });
}
