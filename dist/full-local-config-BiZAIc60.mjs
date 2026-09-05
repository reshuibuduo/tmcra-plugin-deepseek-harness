import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
//#region scripts/local_binding.mjs
async function activeLocalConfigPath() {
	if (process.env.TMCRA_CONFIG_FILE) return null;
	const path = process.env.TMCRA_LOCAL_BINDING_FILE || join(homedir(), ".config", "tmcra", "local-memory.json");
	let binding;
	try {
		binding = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	if (binding?.schemaVersion !== 1 || binding.mode !== "local" || !isAbsolute(binding.dataRoot || "") || ![
		"lite-cpu",
		"balanced-bge",
		"quality-qwen"
	].includes(binding.profile)) throw Error("Invalid local memory selection; cloud fallback is disabled until this selection is repaired.");
	const configPath = join(binding.dataRoot, "state", binding.profile, "secrets", "client-plugin.json");
	if (JSON.parse(await readFile(configPath, "utf8")).deploymentMode !== "local") throw Error("The selected memory installation is not a local identity.");
	return configPath;
}
async function assertActiveMemoryConnection(config) {
	const path = await activeLocalConfigPath();
	if (!path) return;
	const selected = JSON.parse(await readFile(path, "utf8"));
	if (config.baseUrl !== selected.baseUrl || config.apiKey !== selected.apiKey) throw Error("Memory connection changed to local. Restart the host to use the selected local identity; previous cloud requests are blocked.");
}
async function assertCloudProvidersAllowed() {
	if (await activeLocalConfigPath()) throw Error("Local memory is selected; background cloud model requests are blocked.");
}
//#endregion
//#region src/full-local-config.ts
function memoryFetch(connection) {
	return async (input, init) => {
		await assertActiveMemoryConnection(connection);
		return fetch(input, {
			...init,
			redirect: "error"
		});
	};
}
async function readFullLocalConfig() {
	const path = process.env.TMCRA_CONFIG_FILE || await activeLocalConfigPath();
	if (!path) return null;
	const value = JSON.parse(await readFile(path, "utf8"));
	if (value.deploymentMode !== "local") return null;
	const url = new URL(String(value.baseUrl || ""));
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Full-local memory requires a numeric loopback service URL");
	for (const key of [
		"apiKey",
		"globalScope",
		"projectScopePrefix"
	]) if (typeof value[key] !== "string" || !value[key]) throw new Error(`Missing local binding field: ${key}`);
	return {
		baseUrl: url.toString().replace(/\/$/u, ""),
		apiKey: value.apiKey,
		globalScope: value.globalScope,
		projectScopePrefix: value.projectScopePrefix,
		deploymentMode: "local"
	};
}
//#endregion
export { assertCloudProvidersAllowed as i, readFullLocalConfig as n, assertActiveMemoryConnection as r, memoryFetch as t };
