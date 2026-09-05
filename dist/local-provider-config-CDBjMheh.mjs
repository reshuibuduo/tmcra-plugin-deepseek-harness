import { n as readFullLocalConfig, r as assertActiveMemoryConnection } from "./full-local-config-BiZAIc60.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region scripts/memory_controls.mjs
const MODES = Object.freeze([
	"normal",
	"recall_only",
	"off"
]);
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const clean = (text, limit = 4e3) => String(text || "").trim().slice(0, limit);
function controlKey(config, scope) {
	if (!config?.apiKey || !scope) throw new Error("Authenticated scope is required for memory controls");
	return hash(`${String(config.baseUrl).replace(/\/+$/u, "")}\0${config.apiKey}\0${scope}`);
}
function controlsRoot() {
	return process.env.TMCRA_MEMORY_STATE_DIR || (process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, "memory-controls") : join(homedir(), ".config", "tmcra", "memory-controls"));
}
function blank() {
	return {
		schemaVersion: 1,
		sessions: {},
		tasks: {},
		recent: [],
		budgetChars: 12e3
	};
}
async function read(key) {
	if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid memory control key");
	try {
		const state = JSON.parse(await readFile(join(controlsRoot(), `${key}.json`), "utf8"));
		if (state.schemaVersion !== 1) throw new Error("Unsupported memory controls version");
		return state;
	} catch (error) {
		if (error.code === "ENOENT") return blank();
		throw error;
	}
}
async function edit(key, fn) {
	if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid memory control key");
	await mkdir(controlsRoot(), {
		recursive: true,
		mode: 448
	});
	const lockPath = join(controlsRoot(), `${key}.lock`);
	let lock;
	for (let i = 0; i < 60; i++) try {
		lock = await open(lockPath, "wx", 384);
		break;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		await new Promise((r) => setTimeout(r, 25));
	}
	if (!lock) throw new Error("Memory controls busy; retry or inspect the local lock");
	let temporary;
	try {
		const state = await read(key);
		const result = await fn(state);
		temporary = join(controlsRoot(), `${key}.${randomUUID()}.tmp`);
		const file = await open(temporary, "wx", 384);
		try {
			await file.writeFile(JSON.stringify(state));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(controlsRoot(), `${key}.json`));
		return result;
	} finally {
		if (temporary) await unlink(temporary).catch(() => {});
		await lock.close();
		await unlink(lockPath);
	}
}
function session(state, id) {
	if (!clean(id, 500)) throw new Error("An exact session_id is required");
	return state.sessions[hash(id)] ||= {
		mode: "normal",
		generation: 0,
		taskId: null
	};
}
async function memoryPolicy(key, sessionId) {
	const state = await read(key);
	const row = session(state, sessionId);
	const parentId = sessionId.includes(":subagent:") ? sessionId.split(":subagent:")[0] : null;
	const parent = parentId ? session(state, parentId) : null;
	return {
		key,
		sessionId,
		mode: row.mode,
		generation: row.generation,
		turnHash: row.currentTurnHash || null,
		parentTurnHash: parent?.currentTurnHash || null,
		parentGeneration: parent?.generation ?? null,
		read: row.mode !== "off" && parent?.mode !== "off",
		write: row.mode === "normal" && (!parent || parent.mode === "normal")
	};
}
async function mayWrite(capture) {
	if (!capture?.write) return false;
	const current = await memoryPolicy(capture.key, capture.sessionId);
	const state = await read(capture.key);
	const allowed = (id, turnHash) => {
		const row = session(state, id);
		return turnHash ? !row.suppressedTurns?.[turnHash] : !row.suppressLegacyCapture;
	};
	return current.write && current.generation === capture.generation && current.parentGeneration === (capture.parentGeneration ?? null) && allowed(capture.sessionId, capture.turnHash) && (!capture.sessionId.includes(":subagent:") || allowed(capture.sessionId.split(":subagent:")[0], capture.parentTurnHash));
}
async function beginMemoryTurn(key, sessionId, turnId) {
	if (typeof turnId !== "string" || !turnId.trim()) throw new Error("An exact host turn ID is required");
	if ((await memoryPolicy(key, sessionId)).write) await edit(key, (state) => {
		session(state, sessionId).currentTurnHash = hash(turnId);
	});
	return memoryPolicy(key, sessionId);
}
async function suppressMemoryTurn(key, sessionId) {
	return edit(key, (state) => {
		const row = session(state, sessionId);
		if (row.currentTurnHash) (row.suppressedTurns ||= {})[row.currentTurnHash] = true;
		row.suppressLegacyCapture = true;
		return {
			automaticCapture: "suppressed",
			turnIdentified: Boolean(row.currentTurnHash),
			originalMemoryChanged: false
		};
	});
}
async function legacyWriteAllowed(key, { sessionId, sessionHash } = {}) {
	const state = await read(key);
	if (sessionId) {
		const policy = await memoryPolicy(key, sessionId);
		return policy.generation === 0 && (policy.parentGeneration ?? 0) === 0 && await mayWrite({
			...policy,
			turnHash: null,
			parentTurnHash: null
		});
	}
	if (sessionHash) return Object.entries(state.sessions).every(([id, row]) => !id.startsWith(sessionHash) || row.generation === 0 && !row.suppressLegacyCapture);
	return true;
}
async function setMemoryMode(key, sessionId, mode) {
	if (!MODES.includes(mode)) throw new Error("mode must be normal, recall_only or off");
	return edit(key, (state) => {
		const row = session(state, sessionId);
		if (row.mode !== mode) row.generation++;
		row.mode = mode;
		row.changedAt = (/* @__PURE__ */ new Date()).toISOString();
		if (mode !== "normal") row.taskId = null;
		return {
			mode,
			generation: row.generation,
			alreadySubmittedWrites: "cannot_be_recalled",
			pendingOlderGeneration: "discard_on_delivery",
			disabledContentBackfill: false
		};
	});
}
function isContinuation(prompt) {
	return /^(?:好[的]?[,，\s]*)?(?:继续|接着[做来]?|往下[做走]?|补齐这些|完成这些|continue|resume|go on|carry on)[。.!！\s]*$/iu.test(clean(prompt));
}
async function taskContext(key, sessionId, prompt, { capture = null } = {}) {
	const state = await read(key);
	const binding = session(state, sessionId);
	const active = Object.values(state.tasks).filter((row) => row.status === "active");
	let task = state.tasks[binding.taskId];
	if (task?.status !== "active") task = null;
	if (isContinuation(prompt) && !task && active.length === 1) task = active[0];
	if (!isContinuation(prompt)) return {
		query: prompt,
		task: null,
		candidates: []
	};
	if (!task) return {
		query: prompt,
		task: null,
		candidates: active.map(({ id, objective }) => ({
			id,
			objective
		}))
	};
	if (capture && await mayWrite(capture)) await edit(key, (current) => {
		session(current, sessionId).taskId = task.id;
	});
	return {
		query: `${prompt}\nCurrent task: ${task.objective}\nLast observed result: ${task.summary || ""}\nNext step: ${task.nextStep || ""}`.slice(0, 12e3),
		task,
		candidates: []
	};
}
async function updateTask(key, sessionId, { id, objective, summary, nextStep, status = "active" } = {}) {
	const policy = await memoryPolicy(key, sessionId);
	if (!policy.write) throw new Error("Task capture is disabled in this session");
	if (![
		"active",
		"completed",
		"blocked"
	].includes(status)) throw new Error("Invalid task status");
	return edit(key, (state) => {
		const binding = session(state, sessionId);
		if (binding.generation !== policy.generation || binding.mode !== "normal") throw new Error("Memory mode changed");
		if (id && !state.tasks[id]) throw new Error("Unknown task_id in this account and project");
		const taskId = id || `task_${randomUUID()}`;
		const previous = state.tasks[taskId] || {};
		const task = {
			...previous,
			id: taskId,
			objective: clean(objective ?? previous.objective),
			summary: clean(summary ?? previous.summary, 6e3),
			nextStep: clean(nextStep ?? previous.nextStep),
			status,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (!task.objective) throw new Error("A task objective is required");
		state.tasks[taskId] = task;
		binding.taskId = status === "active" ? taskId : null;
		const done = Object.values(state.tasks).filter((item) => item.status !== "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		for (const item of done.slice(100)) delete state.tasks[item.id];
		return task;
	});
}
async function finishObservedTurn(capture, prompt, answer) {
	if (!await mayWrite(capture)) return null;
	const continuation = await taskContext(capture.key, capture.sessionId, prompt, { capture });
	if (isContinuation(prompt) && !continuation.task) return null;
	return updateTask(capture.key, capture.sessionId, {
		id: continuation.task?.id,
		objective: continuation.task?.objective || prompt,
		summary: answer
	});
}
function budgetEvidence(layers, { budgetChars = 12e3, visibleText = "" } = {}) {
	if (!Number.isInteger(budgetChars) || budgetChars < 1e3 || budgetChars > 64e3) throw new Error("budgetChars must be 1000..64000");
	const seen = /* @__PURE__ */ new Set();
	const included = [];
	const omitted = [];
	let used = 0;
	for (const layer of layers) {
		const text = clean(layer.content, 2e5);
		if (!text) continue;
		const blocks = text.split(/\n\n(?=\[(?:Immutable |Slow memory |Fast memory |TMCRA actor section))/u);
		for (const content of blocks) {
			const identity = hash(content);
			const reason = seen.has(identity) || visibleText && visibleText.includes(content) ? "duplicate" : used + content.length + 128 > budgetChars ? "budget" : null;
			seen.add(identity);
			if (reason) {
				omitted.push({
					scope: layer.scope,
					hash: identity,
					reason,
					characters: content.length
				});
				continue;
			}
			included.push({
				scope: layer.scope,
				label: layer.label,
				content,
				hash: identity
			});
			used += content.length + 128;
		}
	}
	return {
		content: included.map((row) => `${row.label || `Memory scope: ${row.scope}`}\n${row.content}`).join("\n\n"),
		included,
		omitted,
		characters: used,
		estimatedTokens: Math.ceil(used / 3),
		tokenEstimateOnly: true,
		budgetChars
	};
}
async function recordMemoryActivity(capture, activity) {
	if (!await mayWrite(capture)) return;
	await edit(capture.key, (state) => {
		const row = session(state, capture.sessionId);
		if (row.mode !== "normal" || row.generation !== capture.generation) return;
		if (activity.kind === "write") {
			const existing = state.recent.find((item) => item.kind === "write" && (activity.outboxId && item.outboxId === activity.outboxId || activity.jobId && item.jobId === activity.jobId));
			if (existing) {
				Object.assign(existing, activity, { updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
				return;
			}
		}
		state.recent.unshift({
			...activity,
			sessionKey: hash(capture.sessionId),
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		state.recent = state.recent.slice(0, 20);
	});
}
async function memoryDashboard(key, sessionId) {
	const state = await read(key);
	return {
		policy: await memoryPolicy(key, sessionId),
		currentTaskId: state.sessions[hash(sessionId)]?.taskId || null,
		tasks: Object.values(state.tasks),
		recent: state.recent.filter((row) => row.sessionKey === hash(sessionId)),
		budgetChars: state.budgetChars
	};
}
async function setMemoryBudget(key, budgetChars) {
	budgetEvidence([], { budgetChars });
	return edit(key, (state) => {
		state.budgetChars = budgetChars;
		return { budgetChars };
	});
}
const PROVIDER_STAGES = Object.freeze(["writer", "organizer"]);
const PROVIDER_KINDS = Object.freeze([
	"deepseek",
	"openai-compatible",
	"local-openai-compatible"
]);
const MAX_SECRET_LENGTH$1 = 4096;
const MAX_TEXT_LENGTH$1 = 512;
async function protectCredentialFile(path) {
	if (process.platform !== "win32") {
		await chmod(path, 384);
		return;
	}
	const identity = spawnSync("whoami.exe", [
		"/user",
		"/fo",
		"csv",
		"/nh"
	], {
		encoding: "utf8",
		windowsHide: true
	});
	const sid = String(identity.stdout || "").match(/S-1-5-(?:\d+-)+\d+/u)?.[0];
	if (identity.status !== 0 || !sid) throw new Error("could not identify the Windows user for credential protection");
	if (spawnSync("icacls.exe", [
		path,
		"/inheritance:r",
		"/grant:r",
		`*${sid}:F`,
		"/grant:r",
		"*S-1-5-18:F"
	], {
		windowsHide: true,
		stdio: "ignore"
	}).status !== 0) throw new Error("could not protect the local provider credential file");
}
function resolveProviderConfigPath(value = process.env.TMCRA_LOCAL_PROVIDER_CONFIG) {
	return resolve(value?.trim() || join(homedir(), ".config", "tmcra", "local-providers.json"));
}
function boundedText$1(value, field, { required = true, maximum = MAX_TEXT_LENGTH$1 } = {}) {
	const normalized = String(value ?? "").trim();
	if (required && !normalized) throw new Error(`${field} is required`);
	if (normalized.length > maximum) throw new Error(`${field} is too long`);
	if (/\r|\n|\0/u.test(normalized)) throw new Error(`${field} contains unsupported characters`);
	return normalized;
}
function loopbackHost$1(hostname) {
	return [
		"localhost",
		"127.0.0.1",
		"::1",
		"[::1]"
	].includes(hostname.toLowerCase());
}
function normalizeProviderBaseUrl(value, field = "provider base URL") {
	const normalized = boundedText$1(value, field, { maximum: 2048 });
	let parsed;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`${field} must be a valid URL`);
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${field} must not contain credentials, query parameters, or fragments`);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHost$1(parsed.hostname))) throw new Error(`${field} must use HTTPS; exact loopback hosts may use HTTP`);
	return parsed.toString().replace(/\/+$/u, "");
}
function normalizeSecret(value, field) {
	const normalized = String(value ?? "").trim();
	if (normalized.length > MAX_SECRET_LENGTH$1) throw new Error(`${field} is too long`);
	if (/\r|\n|\0/u.test(normalized)) throw new Error(`${field} contains unsupported characters`);
	return normalized;
}
function normalizeStage(stage, input, previous = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${stage} configuration must be an object`);
	const provider = boundedText$1(input.provider, `${stage} provider`);
	if (!PROVIDER_KINDS.includes(provider)) throw new Error(`${stage} provider is unsupported`);
	const baseUrl = normalizeProviderBaseUrl(input.baseUrl, `${stage} base URL`);
	const model = boundedText$1(input.model, `${stage} model`);
	let reusablePreviousKey = "";
	try {
		if (String(previous.provider ?? "").trim() === provider && normalizeProviderBaseUrl(previous.baseUrl, `${stage} previous base URL`) === baseUrl) reusablePreviousKey = String(previous.apiKey ?? "").trim();
	} catch {
		reusablePreviousKey = "";
	}
	const apiKey = normalizeSecret(input.clearApiKey === true ? "" : String(input.apiKey ?? "").trim() || reusablePreviousKey, `${stage} API key`);
	return {
		provider,
		baseUrl,
		model,
		...apiKey ? { apiKey } : {}
	};
}
function normalizeProviderConfig(input, previous = void 0) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("provider configuration must be an object");
	const prior = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
	const writer = normalizeStage("writer", input.writer, prior.writer);
	const organizerInput = input.organizer;
	if (!organizerInput || typeof organizerInput !== "object" || Array.isArray(organizerInput)) throw new Error("organizer configuration must be an object");
	return {
		schemaVersion: 1,
		execution: "local",
		writer,
		organizer: organizerInput.inheritWriter !== false ? { inheritWriter: true } : {
			inheritWriter: false,
			...normalizeStage("organizer", organizerInput, prior.organizer)
		},
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function assertStoredConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local provider configuration must contain a JSON object");
	if (value.schemaVersion !== 1 || value.execution !== "local") throw new Error("local provider configuration version is unsupported");
	const normalized = normalizeProviderConfig(value, value);
	const updatedAt = boundedText$1(value.updatedAt, "updatedAt", { maximum: 64 });
	if (Number.isNaN(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
	normalized.updatedAt = updatedAt;
	return normalized;
}
async function readProviderConfig(path = resolveProviderConfigPath()) {
	if (!existsSync(path)) return null;
	return assertStoredConfig(JSON.parse(await readFile(path, "utf8")));
}
function publicProviderConfig(value) {
	if (!value) return {
		schemaVersion: 1,
		execution: "local",
		configured: false,
		writer: null,
		organizer: { inheritWriter: true }
	};
	const publicStage = (stage) => ({
		provider: stage.provider,
		baseUrl: stage.baseUrl,
		model: stage.model,
		credentialPresent: Boolean(stage.apiKey)
	});
	return {
		schemaVersion: 1,
		execution: "local",
		configured: true,
		writer: publicStage(value.writer),
		organizer: value.organizer.inheritWriter ? {
			inheritWriter: true,
			credentialPresent: Boolean(value.writer.apiKey)
		} : {
			inheritWriter: false,
			...publicStage(value.organizer)
		},
		updatedAt: value.updatedAt
	};
}
async function writeProviderConfig(input, path = resolveProviderConfigPath()) {
	const value = normalizeProviderConfig(input, await readProviderConfig(path).catch((error) => {
		if (error?.code === "ENOENT") return null;
		throw error;
	}) ?? void 0);
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = join(dirname(path), `.${randomUUID().replaceAll("-", "")}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384,
			flag: "wx"
		});
		await protectCredentialFile(temporary);
		await rename(temporary, path);
		await protectCredentialFile(path);
	} finally {
		await rm(temporary, { force: true }).catch(() => void 0);
	}
	return publicProviderConfig(value);
}
async function clearProviderCredential(stage, path = resolveProviderConfigPath()) {
	if (!PROVIDER_STAGES.includes(stage)) throw new Error("provider stage is unsupported");
	const current = await readProviderConfig(path);
	if (!current) return publicProviderConfig(null);
	if (stage === "writer") delete current.writer.apiKey;
	else if (!current.organizer.inheritWriter) delete current.organizer.apiKey;
	current.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
	return writeProviderConfig({
		...current,
		writer: {
			...current.writer,
			apiKey: current.writer.apiKey ?? "",
			clearApiKey: !current.writer.apiKey
		},
		organizer: current.organizer.inheritWriter ? { inheritWriter: true } : {
			...current.organizer,
			apiKey: current.organizer.apiKey ?? "",
			clearApiKey: !current.organizer.apiKey
		}
	}, path);
}
function resolvedProviderStage(config, stage) {
	if (stage === "writer") return config.writer;
	if (stage === "organizer") return config.organizer.inheritWriter ? config.writer : config.organizer;
	throw new Error("provider stage is unsupported");
}
async function probeProvider(stage, input, { path = resolveProviderConfigPath(), fetchImpl = fetch, timeoutMs = 15e3, mode = "models" } = {}) {
	if (!["models", "inference"].includes(mode)) throw new Error("Unknown provider test mode");
	const target = resolvedProviderStage(normalizeProviderConfig(input, await readProviderConfig(path) ?? void 0), stage);
	if (!target.apiKey && !loopbackHost$1(new URL(target.baseUrl).hostname)) throw new Error(`${stage} API key is required for a remote provider`);
	const url = `${target.baseUrl}/${mode === "inference" ? "chat/completions" : "models"}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const started = performance.now();
	try {
		const response = await fetchImpl(url, {
			method: mode === "inference" ? "POST" : "GET",
			headers: {
				Accept: "application/json",
				...mode === "inference" ? { "Content-Type": "application/json" } : {},
				...target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}
			},
			redirect: "error",
			signal: controller.signal,
			...mode === "inference" ? { body: JSON.stringify({
				model: target.model,
				messages: [{
					role: "user",
					content: `Synthetic TMCRA ${stage} connectivity test. Reply with the JSON object {"ok":true,"stage":"${stage}"} and nothing else.`
				}],
				max_tokens: 2048,
				temperature: 0,
				response_format: { type: "json_object" },
				...target.provider === "deepseek" ? {
					thinking: { type: "disabled" },
					enable_thinking: false
				} : {}
			}) } : {}
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
		let payload;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error("provider returned a non-JSON model response");
		}
		const modelIds = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id ?? "")).filter(Boolean) : [];
		if (mode === "inference") {
			let answer;
			try {
				answer = JSON.parse(payload?.choices?.[0]?.message?.content || "");
			} catch {
				throw new Error("模型响应未通过 JSON 结构校验，请检查模型和输出参数。");
			}
			if (answer.ok !== true || answer.stage !== stage || payload?.choices?.[0]?.finish_reason !== "stop") throw new Error("模型响应不完整或未通过测试样本校验。");
		}
		return {
			ok: true,
			stage,
			endpoint: new URL(target.baseUrl).origin,
			model: target.model,
			testMode: mode,
			...mode === "inference" ? {
				servedModel: String(payload.model || target.model).slice(0, 512),
				inferenceValidated: true,
				syntheticDataOnly: true
			} : {},
			modelVisible: modelIds.length === 0 ? null : modelIds.includes(target.model),
			latencyMs: Math.max(0, Math.round(performance.now() - started))
		};
	} catch (error) {
		if (error?.name === "AbortError") throw new Error("provider connection timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
//#region scripts/local_deployment.mjs
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = [
	process.env.TMCRA_LOCAL_API_ROOT,
	join(pluginRoot, "runtime/memory-api"),
	resolve(pluginRoot, "../tmcra-source/02-tmcra-memory-api")
].filter(Boolean).find((path) => existsSync(join(path, "deploy/Install-TmcraLocal.ps1")));
const dataRoot = resolve(process.env.TMCRA_LOCAL_DATA_ROOT || join(process.env.LOCALAPPDATA || homedir(), "TMCRA/local"));
let operation = { state: "idle" };
async function readJson(path, fallback) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return fallback;
		throw error;
	}
}
async function installedApiRoot() {
	return (await readJson(join(dataRoot, "installation.json"), null))?.api_root || apiRoot;
}
async function localDeploymentStatus() {
	const catalog = await readJson(new URL("../resources/local-model-profiles.json", import.meta.url), { profiles: [] });
	const installed = await readJson(join(dataRoot, "installation.json"), null);
	const running = await readJson(join(dataRoot, "running.json"), null);
	const launchError = await readJson(join(dataRoot, "launch-error.json"), null);
	if (operation.state === "starting" && launchError?.at * 1e3 >= Date.parse(operation.startedAt)) operation = {
		...operation,
		state: "failed",
		error: launchError.detail
	};
	let ready = false;
	if (installed && Number.isInteger(installed.api_port) && installed.api_port > 1023 && installed.api_port < 65536) try {
		const response = await fetch(`http://127.0.0.1:${installed.api_port}/readyz`, {
			signal: AbortSignal.timeout(1500),
			redirect: "error"
		});
		const body = await response.json();
		ready = response.ok && (body.status === "ready" || body.ready === true);
	} catch {}
	if (ready && operation.state === "starting") operation.state = "ready";
	return {
		available: process.platform === "win32" && process.arch === "x64" && Boolean(apiRoot),
		requirement: "Windows x64；自动准备 Python，无需 TMCRA 账号；首次下载需要联网",
		missing: apiRoot ? null : "本地运行包不完整，请重新下载安装包。",
		profiles: catalog.profiles,
		dataRoot,
		ramGiB: Math.round(totalmem() / 1024 ** 3),
		recommendedProfile: installed?.hardware?.recommended_profile || "lite-cpu",
		installedProfile: installed?.profile || null,
		ready,
		running: Boolean(running && !running.stopped),
		operation: { ...operation },
		connectionConfig: installed ? join(dataRoot, "state", installed.profile, "secrets/client-plugin.json") : null,
		automaticLocalBinding: Boolean(installed)
	};
}
async function installLocalDeployment(profile) {
	const state = await localDeploymentStatus();
	if (!state.available) throw Error(state.missing || state.requirement);
	const selected = state.profiles.find((p) => p.id === profile);
	if (!selected) throw Error("请选择已登记的本地模型档位。");
	if (["installing", "starting"].includes(operation.state) || state.running) throw Error("本地任务正在运行，请先查看状态或停止实例。");
	if (state.ramGiB < selected.system_ram_gib_min) throw Error(`此档位至少需要 ${selected.system_ram_gib_min}GB 内存。`);
	operation = {
		state: "installing",
		profile,
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		event: "正在准备独立运行环境"
	};
	await mkdir(dataRoot, { recursive: true });
	const log = createWriteStream(join(dataRoot, "installation.log"), {
		flags: "a",
		mode: 384
	});
	log.on("error", () => {});
	const child = spawn("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		join(apiRoot, "deploy/Install-TmcraLocal.ps1"),
		"-Profile",
		profile,
		"-DataDir",
		dataRoot,
		"-Device",
		profile === "lite-cpu" ? "cpu" : "auto"
	], {
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	let pending = "";
	child.stdout.on("data", (chunk) => {
		log.write(chunk);
		pending = (pending + chunk.toString()).slice(-12e3);
		const lines = pending.split(/\r?\n/u);
		pending = lines.pop();
		for (const line of lines) try {
			const value = JSON.parse(line);
			if (typeof value.event === "string") operation.event = value.event;
		} catch {}
	});
	child.stderr.on("data", (chunk) => log.write(chunk));
	child.on("error", (error) => {
		operation = {
			...operation,
			state: "failed",
			error: `无法启动安装程序：${error.code || "unknown"}`
		};
	});
	child.on("exit", (code) => {
		log.end();
		operation = {
			...operation,
			state: code === 0 ? "starting" : "failed",
			...code !== 0 ? { error: "安装未完成。已下载文件保留；请查看本地安装日志后重试。" } : {}
		};
	});
	return { ...operation };
}
async function stopLocalDeployment() {
	const state = await localDeploymentStatus();
	if (!apiRoot || !state.running) return { stopped: true };
	const runtimeRoot = await installedApiRoot();
	return new Promise((resolveStop, reject) => {
		const child = spawn(join(dataRoot, "venv/Scripts/python.exe"), [
			"-m",
			"tmcra_service.local_deployment",
			"stop",
			"--root",
			dataRoot
		], {
			cwd: runtimeRoot,
			windowsHide: true,
			stdio: "ignore"
		});
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? (operation = { state: "idle" }, resolveStop({ stopRequested: true })) : reject(Error("停止请求失败；现有本地数据保持原样。")));
	});
}
async function startLocalDeployment() {
	const state = await localDeploymentStatus();
	if (!state.available || !state.installedProfile) throw Error("请先完成本地运行包和模型安装。");
	if (state.running || ["installing", "starting"].includes(operation.state)) throw Error("本地实例正在运行或启动中。");
	operation = {
		state: "starting",
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	const runtimeRoot = await installedApiRoot();
	const child = spawn(join(dataRoot, "venv/Scripts/python.exe"), [
		"-m",
		"tmcra_service.local_deployment",
		"run",
		"--root",
		dataRoot
	], {
		cwd: runtimeRoot,
		windowsHide: true,
		detached: true,
		stdio: "ignore"
	});
	child.on("error", (error) => {
		operation = {
			...operation,
			state: "failed",
			error: `启动失败：${error.code || "unknown"}`
		};
	});
	child.unref();
	return { ...operation };
}
//#endregion
//#region scripts/memory_center.mjs
function openBrowser(url) {
	const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	const child = spawn(command, args, {
		windowsHide: true,
		detached: true,
		stdio: "ignore"
	});
	child.on("error", () => {});
	child.unref();
}
function createMemoryActions({ config, scope, sessionId, globalScope, request, status = async () => ({}), confirmFeedback }) {
	if (!sessionId?.trim()) throw new Error("An exact session_id is required");
	const key = controlKey(config, scope);
	const originalRequest = request;
	request = async (...args) => {
		await assertActiveMemoryConnection(config);
		return originalRequest(...args);
	};
	return async (action, args = {}) => {
		if (action === "dashboard") {
			const data = await memoryDashboard(key, sessionId);
			delete data.policy.key;
			return {
				...data,
				scope,
				sessionId,
				availableScopes: [{
					scope,
					label: "当前项目"
				}, ...globalScope && globalScope !== scope ? [{
					scope: globalScope,
					label: "个人全局"
				}] : []],
				delivery: await status()
			};
		}
		if ([
			"knowledge",
			"graph",
			"evidence"
		].includes(action)) {
			const target = args.scope || scope;
			if (![scope, globalScope].includes(target)) throw new Error("Requested scope is outside this project and user-global boundary");
			if (!(await memoryPolicy(key, sessionId)).read) throw new Error("记忆已关闭。请先在会话设置中启用召回，再浏览远程知识。");
			if (action === "evidence" && (typeof args.memory_id !== "string" || !args.memory_id.trim() || args.memory_id.length > 200)) throw new Error("An exact evidence ID is required");
			const endpoint = action === "knowledge" ? "knowledge-base" : action === "graph" ? "memory-graph/visual-atlas" : `memory-graph/nodes/${encodeURIComponent(args.memory_id)}/evidence?limit=25${args.cursor ? `&cursor=${encodeURIComponent(String(args.cursor).slice(0, 512))}` : ""}`;
			return request(`/v1/scopes/${encodeURIComponent(target)}/${endpoint}`, {
				method: "GET",
				headers: {}
			});
		}
		if (action === "mode") return setMemoryMode(key, sessionId, args.mode);
		if (action === "budget") return setMemoryBudget(key, Number(args.budgetChars));
		if (action === "task") return updateTask(key, sessionId, args);
		if (action === "correction_start") return suppressMemoryTurn(key, sessionId);
		if (action === "feedback") {
			const capture = await memoryPolicy(key, sessionId);
			if (confirmFeedback) await suppressMemoryTurn(key, sessionId);
			if (!(await memoryPolicy(key, sessionId)).write) throw new Error("This session is not in normal memory mode");
			const target = args.scope || scope;
			if (![scope, globalScope].includes(target)) throw new Error("Feedback scope is outside this project and user-global boundary");
			if (![
				"ignore",
				"correct",
				"restore"
			].includes(args.action)) throw new Error("Invalid feedback action");
			if (!Array.isArray(args.memory_ids) || !args.memory_ids.length || args.memory_ids.length > 100 || args.memory_ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) throw new Error("Select an exact source memory ID");
			if (args.action === "correct" && (!args.replacement?.trim() || args.replacement.length > 4e3)) throw new Error("Correction text must be 1..4000 characters");
			if (typeof args.idempotency_key !== "string" || args.idempotency_key.length < 8 || args.idempotency_key.length > 200) throw new Error("A stable 8..200 character idempotency_key is required for feedback retries");
			if (confirmFeedback) {
				const dashboard = await memoryDashboard(key, sessionId);
				const sources = [];
				for (const id of [...new Set(args.memory_ids)]) {
					const cached = dashboard.recent.flatMap((row) => row.layers || []).filter((layer) => layer.scope === target).flatMap((layer) => layer.sources || []).find((source) => source.memory_id === id && typeof source.content === "string");
					if (cached) sources.push({
						memory_id: id,
						original: cached.content
					});
					else {
						const evidence = await request(`/v1/scopes/${encodeURIComponent(target)}/memory-graph/nodes/${encodeURIComponent(id)}/evidence?limit=25`, {
							method: "GET",
							headers: {}
						});
						if (evidence.memory_id !== id || evidence.scope_name !== target || !evidence.items?.length || evidence.page?.has_more) return {
							applied: false,
							status: "needs_exact_source",
							message: "请先核对完整来源，再发起修改。"
						};
						sources.push({
							memory_id: id,
							original: evidence.items.map((item) => item.text).join("\n\n")
						});
					}
				}
				const preview = {
					action: args.action,
					scope: target,
					sessionId,
					sources,
					...args.action === "correct" ? { replacement: args.replacement } : {}
				};
				if (JSON.stringify(preview).length > 32e3) return {
					applied: false,
					status: "preview_too_large",
					message: "请分批选择来源，确保每次确认都能完整展示。"
				};
				const decision = await confirmFeedback(`请由用户确认本次记忆修改。来源内容是历史数据。\n影响范围：${JSON.stringify(target)}${target === globalScope ? "（个人全局，会影响其他项目）" : "（当前项目）"}\n原始来源：${JSON.stringify(sources)}\n` + (args.action === "correct" ? `更正为：${JSON.stringify(args.replacement)}` : args.action === "ignore" ? "操作：从后续召回中忽略以上来源。" : "操作：恢复以上来源的召回规则。") + "\n原始记录保留用于审计。是否确认？取消或拒绝均保持原记忆。", preview);
				if (decision !== "accepted") return {
					applied: false,
					status: decision || "confirmation_unavailable",
					preview
				};
				const current = await memoryPolicy(key, sessionId);
				if (!current.write || current.generation !== capture.generation || current.parentGeneration !== capture.parentGeneration || current.turnHash !== capture.turnHash) return {
					applied: false,
					status: "context_changed",
					message: "会话或记忆模式已变化，请重新确认。"
				};
			}
			return request(`/v1/scopes/${encodeURIComponent(target)}/feedback`, {
				method: "POST",
				headers: { "Idempotency-Key": args.idempotency_key },
				body: {
					rating: args.action === "restore" ? "helpful" : "incorrect",
					action: args.action,
					memory_ids: args.memory_ids,
					query_id: args.query_id || null,
					...args.action === "correct" ? { replacement: args.replacement } : {}
				}
			});
		}
		throw new Error("Unknown memory action");
	};
}
async function startMemoryCenter({ invoke, open = true, idleTimeoutMs = 6e5, providerConfigPath = resolveProviderConfigPath() } = {}) {
	if (typeof invoke !== "function") throw new Error("Memory action handler is required");
	const html = await readFile(new URL("../resources/memory-center.html", import.meta.url));
	const logo = await readFile(new URL("../assets/tmcra-logo.png", import.meta.url));
	const panels = await readFile(new URL("../resources/workspace-panels.js", import.meta.url));
	const panelStyles = await readFile(new URL("../resources/workspace-panels.css", import.meta.url));
	const token = randomBytes(32).toString("base64url");
	let baseUrl = "";
	let timer;
	const json = (res, code, value) => {
		res.writeHead(code, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff"
		});
		res.end(JSON.stringify(value));
	};
	const server = createServer(async (req, res) => {
		try {
			if (req.headers.host !== new URL(baseUrl).host) return json(res, 421, { error: "Loopback host required" });
			if (req.headers.origin && req.headers.origin !== baseUrl) return json(res, 403, { error: "Origin rejected" });
			if (req.method === "GET" && req.url === "/") {
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
				});
				return res.end(html);
			}
			if (req.method === "GET" && req.url === "/assets/tmcra-logo.png") {
				res.writeHead(200, {
					"Content-Type": "image/png",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff"
				});
				return res.end(logo);
			}
			if (req.method === "GET" && ["/assets/workspace-panels.js", "/assets/workspace-panels.css"].includes(req.url)) {
				const js = req.url.endsWith(".js");
				res.writeHead(200, {
					"Content-Type": js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff"
				});
				return res.end(js ? panels : panelStyles);
			}
			if (req.headers["x-tmcra-token"] !== token) return json(res, 403, { error: "Local authorization required" });
			if (req.method !== "POST" || req.url !== "/api/action") return json(res, 404, { error: "Unknown endpoint" });
			if (!String(req.headers["content-type"]).startsWith("application/json")) return json(res, 415, { error: "JSON required" });
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 65536) return json(res, 413, { error: "Request too large" });
				chunks.push(chunk);
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			clearTimeout(timer);
			timer = setTimeout(() => server.close(), idleTimeoutMs);
			timer.unref();
			if (body.action === "close") {
				json(res, 200, { ok: true });
				server.close();
				return;
			}
			const args = body.args || {};
			if (body.action === "local_deployment_status") return json(res, 200, {
				ok: true,
				result: await localDeploymentStatus()
			});
			if (body.action === "local_deployment_install") return json(res, 200, {
				ok: true,
				result: await installLocalDeployment(args.profile)
			});
			if (body.action === "local_deployment_stop") return json(res, 200, {
				ok: true,
				result: await stopLocalDeployment()
			});
			if (body.action === "local_deployment_start") return json(res, 200, {
				ok: true,
				result: await startLocalDeployment()
			});
			if (body.action === "providers_read") return json(res, 200, {
				ok: true,
				result: publicProviderConfig(await readProviderConfig(providerConfigPath))
			});
			if (body.action === "providers_save") return json(res, 200, {
				ok: true,
				result: await writeProviderConfig(args.config, providerConfigPath)
			});
			if (body.action === "providers_clear") return json(res, 200, {
				ok: true,
				result: await clearProviderCredential(args.stage, providerConfigPath)
			});
			if (body.action === "providers_test") return json(res, 200, {
				ok: true,
				result: await probeProvider(args.stage, args.config, {
					path: providerConfigPath,
					mode: "inference",
					timeoutMs: 25e3
				})
			});
			json(res, 200, {
				ok: true,
				result: await invoke(body.action, body.args)
			});
		} catch (error) {
			json(res, 400, {
				ok: false,
				error: error.message
			});
		}
	});
	server.requestTimeout = 15e3;
	server.headersTimeout = 1e4;
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
	const url = `${baseUrl}/#${token}`;
	timer = setTimeout(() => server.close(), idleTimeoutMs);
	timer.unref();
	server.once("close", () => clearTimeout(timer));
	if (open) openBrowser(url);
	return {
		server,
		url,
		baseUrl,
		token
	};
}
//#endregion
//#region src/sdk/queue.ts
async function nodeFileSystem() {
	return await import("node:fs/promises");
}
async function nodePath() {
	return await import("node:path");
}
/**
* Small JSON-file queue. It is opt-in so browser consumers remain zero-runtime
* dependency; Node consumers can point it at an application data directory.
* Writes use a temporary file followed by rename for crash-safe replacement.
*/
var FilePendingTurnQueue = class {
	writeChain = Promise.resolve();
	filePath;
	constructor(filePath) {
		this.filePath = filePath;
		if (!filePath.trim()) throw new TypeError("filePath is required");
	}
	async readState() {
		const fs = await nodeFileSystem();
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") throw new Error("invalid TMCRA pending queue format");
			return {
				version: 1,
				records: parsed.records
			};
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return {
				version: 1,
				records: {}
			};
			throw error;
		}
	}
	async writeState(state) {
		const fs = await nodeFileSystem();
		const path = await nodePath();
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.tmp-${processSafeRandom()}`;
		await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
		await fs.rename(temporaryPath, this.filePath);
	}
	async mutate(mutator) {
		const operation = this.writeChain.then(async () => {
			const state = await this.readState();
			mutator(state);
			await this.writeState(state);
		});
		this.writeChain = operation.catch(() => void 0);
		return operation;
	}
	async enqueue(record) {
		await this.mutate((state) => {
			const current = state.records[record.idempotencyKey];
			if (current && JSON.stringify(current.body) !== JSON.stringify(record.body)) throw new Error(`pending turn ${record.idempotencyKey} already exists with a different body`);
			if (!current) state.records[record.idempotencyKey] = record;
		});
	}
	async update(idempotencyKey, patch) {
		await this.mutate((state) => {
			const current = state.records[idempotencyKey];
			if (!current) return;
			state.records[idempotencyKey] = {
				...current,
				...patch,
				updatedAt: Date.now()
			};
		});
	}
	async remove(idempotencyKey) {
		await this.mutate((state) => {
			delete state.records[idempotencyKey];
		});
	}
	async list() {
		await this.writeChain;
		const state = await this.readState();
		return Object.freeze(Object.values(state.records).map((record) => ({
			...record,
			body: {
				...record.body,
				messages: [...record.body.messages]
			}
		})));
	}
};
function processSafeRandom() {
	const webCrypto = globalThis.crypto;
	if (webCrypto?.randomUUID) return webCrypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
//#endregion
//#region src/local-provider-config.ts
const PROVIDERS = /* @__PURE__ */ new Set([
	"deepseek",
	"openai-compatible",
	"local-openai-compatible"
]);
const MAX_TEXT_LENGTH = 512;
const MAX_SECRET_LENGTH = 4096;
function resolveLocalProviderConfigPath(value = process.env.TMCRA_LOCAL_PROVIDER_CONFIG) {
	return resolve(value?.trim() || join(homedir(), ".config", "tmcra", "local-providers.json"));
}
function boundedText(value, field, maximum = MAX_TEXT_LENGTH) {
	const normalized = String(value ?? "").trim();
	if (!normalized || normalized.length > maximum || /[\r\n\0]/u.test(normalized)) throw new Error(`tmcra-memory: ${field} is invalid`);
	return normalized;
}
function loopbackHost(hostname) {
	return [
		"localhost",
		"127.0.0.1",
		"::1",
		"[::1]"
	].includes(hostname.toLowerCase());
}
function providerBaseUrl(value, field) {
	const normalized = boundedText(value, field, 2048);
	let parsed;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`tmcra-memory: ${field} must be a valid URL`);
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`tmcra-memory: ${field} contains unsupported URL components`);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHost(parsed.hostname))) throw new Error(`tmcra-memory: ${field} must use HTTPS; loopback may use HTTP`);
	return parsed.toString().replace(/\/+$/u, "");
}
function providerStage(value, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tmcra-memory: ${field} must be an object`);
	const input = value;
	const provider = boundedText(input.provider, `${field} provider`);
	if (!PROVIDERS.has(provider)) throw new Error(`tmcra-memory: ${field} provider is unsupported`);
	const apiKey = String(input.apiKey ?? "").trim();
	if (apiKey.length > MAX_SECRET_LENGTH || /[\r\n\0]/u.test(apiKey)) throw new Error(`tmcra-memory: ${field} API key is invalid`);
	return {
		provider,
		baseUrl: providerBaseUrl(input.baseUrl, `${field} base URL`),
		model: boundedText(input.model, `${field} model`),
		...apiKey ? { apiKey } : {}
	};
}
function validateStoredConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tmcra-memory: local provider configuration must be an object");
	const input = value;
	if (input.schemaVersion !== 1 || input.execution !== "local") throw new Error("tmcra-memory: local provider configuration version is unsupported");
	const writer = providerStage(input.writer, "writer");
	if (!input.organizer || typeof input.organizer !== "object" || Array.isArray(input.organizer)) throw new Error("tmcra-memory: organizer configuration must be an object");
	const organizerInput = input.organizer;
	const organizer = organizerInput.inheritWriter !== false ? { inheritWriter: true } : {
		inheritWriter: false,
		...providerStage(organizerInput, "organizer")
	};
	const updatedAt = boundedText(input.updatedAt, "provider updatedAt", 64);
	if (Number.isNaN(Date.parse(updatedAt))) throw new Error("tmcra-memory: provider updatedAt must be an ISO timestamp");
	return {
		schemaVersion: 1,
		execution: "local",
		writer,
		organizer,
		updatedAt
	};
}
async function readLocalProviderConfig(path = resolveLocalProviderConfigPath()) {
	if (await readFullLocalConfig()) return null;
	if (!existsSync(path)) return null;
	return validateStoredConfig(JSON.parse(await readFile(path, "utf8")));
}
function resolvedLocalProviderStage(config, stage) {
	if (stage === "writer") return config.writer;
	return config.organizer.inheritWriter ? config.writer : config.organizer;
}
function localProviderStageReady(config, stage) {
	const target = resolvedLocalProviderStage(config, stage);
	return Boolean(target.apiKey) || loopbackHost(new URL(target.baseUrl).hostname);
}
//#endregion
export { createMemoryActions as a, budgetEvidence as c, legacyWriteAllowed as d, mayWrite as f, taskContext as h, FilePendingTurnQueue as i, controlKey as l, recordMemoryActivity as m, readLocalProviderConfig as n, startMemoryCenter as o, memoryDashboard as p, resolvedLocalProviderStage as r, beginMemoryTurn as s, localProviderStageReady as t, finishObservedTurn as u };
