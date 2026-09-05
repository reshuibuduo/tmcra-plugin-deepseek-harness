import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const packagedTextFiles = [
  "cordis.patch.yml",
  "dist/cli.d.mts",
  "dist/cli.mjs",
  "dist/index.d.mts",
  "dist/index.mjs",
  "LICENSE",
  "package.json",
  "resources/provider-settings.html",
  "resources/memory-center.html",
  "resources/workspace-panels.js",
  "resources/workspace-panels.css",
  "resources/local-model-profiles.json",
  "scripts/local_deployment.mjs",
  "scripts/local_binding.mjs",
  "scripts/local_binding.d.mts",
  "scripts/local_setup.mjs",
  "scripts/memory_center.d.mts",
  "scripts/memory_controls.d.mts",
  "scripts/memory_controls.mjs",
  "scripts/memory_center.mjs",
  "README.md",
  "README.zh-CN.md",
  "scripts/provider_config.mjs",
  "scripts/provider_setup.mjs",
];

const chunks = (await readdir(join(packageRoot, "dist"))).filter((name) => name.endsWith(".mjs") || name.endsWith(".d.mts")).map((name) => `dist/${name}`);
for (const relativePath of new Set([...packagedTextFiles, ...chunks])) {
  const path = join(packageRoot, ...relativePath.split("/"));
  let content = (await readFile(path, "utf8")).replace(/\r\n?/gu, "\n");
  if (relativePath.startsWith("dist/")) {
    content = content.replace(
      /^\/\/#region .*[/\\](src[/\\].*)$/gmu,
      (_match, sourcePath) => `//#region ${sourcePath.replaceAll("\\", "/")}`,
    );
  }
  await writeFile(path, content, "utf8");
}
