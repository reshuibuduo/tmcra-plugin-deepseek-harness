import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TMCRAMemoryLifecycle } from "../src/sdk/lifecycle.ts";
import { MemoryPendingTurnQueue } from "../src/sdk/queue.ts";
import type { RecallResponse, JobView } from "../src/sdk/models.ts";
import { controlKey, setMemoryMode, updateTask, suppressMemoryTurn } from "../scripts/memory_controls.mjs";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tmcra-dsh-controls-")); vi.stubEnv("TMCRA_MEMORY_STATE_DIR", directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const connection = { baseUrl: "https://example.invalid", apiKey: "isolated-controls-test" };
const key = controlKey(connection, "project");
function setup() {
  const queue = new MemoryPendingTurnQueue();
  const client = {
    recall: vi.fn(async (scope: string, _body: unknown): Promise<RecallResponse> => ({ query_id: "q1", scope_name: scope, index_job_id: "idx",
      evidence_route: { requested: "raw", selected: "raw", reasons: [] }, evidence: {}, debug: null,
      prompt_evidence: { schema_version: "tmcra.prompt-evidence.1", format: "text/plain", mode: "raw_hierarchical", content: "The known source", content_sha256: "test", content_character_count: 16, source_text_verbatim: true, trust_boundary: "untrusted" } })),
    ingest: vi.fn(async (): Promise<JobView> => ({ job_id: "job1", tenant_id: "test", scope_name: "project", job_type: "ingest", status: "pending", attempts: 0, created_at: 0, updated_at: 0 } as JobView)),
    waitForJob: vi.fn(async (): Promise<JobView> => ({ job_id: "job1", status: "succeeded" } as JobView)),
  };
  const lifecycle = new TMCRAMemoryLifecycle(client, { projectScope: "project", memoryControlKey: key, pendingQueue: queue, waitForIngest: false });
  return { lifecycle, client, queue };
}

it('skips a correction turn while preserving an older prepared normal turn', async()=>{
  const {lifecycle,client}=setup();
  const previous=await lifecycle.prepareTurn('normal work',{sessionId:'s',turnId:'old'});
  const pending=await lifecycle.prepareTurn('correct this memory',{sessionId:'s',turnId:'correction'});
  await suppressMemoryTurn(key,'s');
  await expect(lifecycle.commitTurn(pending,'awaiting user confirmation')).rejects.toThrow('write skipped');
  expect(client.ingest).not.toHaveBeenCalled();
  await lifecycle.commitTurn(previous,'completed earlier work');
  expect(client.ingest).toHaveBeenCalledTimes(1);
});

it("recall-only reads and off skips all memory traffic", async () => {
  const { lifecycle, client, queue } = setup();
  await setMemoryMode(key, "s", "recall_only");
  const read = await lifecycle.prepareTurn("private turn", { sessionId: "s" });
  expect(client.recall).toHaveBeenCalledTimes(1);
  await expect(lifecycle.commitTurn(read, "private result")).rejects.toThrow("memory mode");
  expect(await queue.list()).toHaveLength(0);
  await setMemoryMode(key, "s", "off");
  expect((await lifecycle.prepareTurn("hidden turn", { sessionId: "s" })).systemContext).toBe("");
  expect(client.recall).toHaveBeenCalledTimes(1);
  expect(client.ingest).not.toHaveBeenCalled();
});

it("uses the task objective for a continuation and deduplicates visible evidence", async () => {
  const { lifecycle, client } = setup();
  await updateTask(key, "old-session", { objective: "Finish device authentication", nextStep: "Test expired code" });
  const prepared = await lifecycle.prepareTurn("继续", { sessionId: "new-session", visibleContext: "The known source" });
  expect(client.recall.mock.calls[0]?.[1]).toMatchObject({ query: expect.stringContaining("Finish device authentication") });
  expect(prepared.userContent).toBe("继续");
  expect(prepared.systemContext).not.toContain("The known source");
  expect(prepared.systemContext).toContain("Test expired code");
  const afterCompact = await lifecycle.prepareTurn("继续", { sessionId: "new-session", visibleContext: "short summary" });
  expect(afterCompact.systemContext).toContain("The known source");
});

it("discards a failed pending write after the session was turned off and on", async () => {
  const { lifecycle, client, queue } = setup();
  client.ingest.mockRejectedValueOnce(new Error("temporary disconnect"));
  const prepared = await lifecycle.prepareTurn("Finish authentication", { sessionId: "s" });
  await expect(lifecycle.commitTurn(prepared, "ready for tests")).rejects.toThrow("disconnect");
  expect(await queue.list()).toHaveLength(1);
  await setMemoryMode(key, "s", "off");
  await setMemoryMode(key, "s", "normal");
  const results = await lifecycle.reconcilePendingTurns();
  expect(results[0]?.status).toBe("discarded");
  expect(await queue.list()).toHaveLength(0);
  expect(client.ingest).toHaveBeenCalledTimes(1);
});
