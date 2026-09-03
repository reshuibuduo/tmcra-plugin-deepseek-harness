import { readFile, writeFile } from "node:fs/promises";
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
  "README.md",
  "README.zh-CN.md",
];

for (const relativePath of packagedTextFiles) {
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
