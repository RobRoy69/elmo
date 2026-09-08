import { randomUUID } from "node:crypto";
import { normalizeCellBatchRequest } from "@workspace/lib/cell-batches";
import { Pool } from "pg";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNetlifyBatch, readNetlifyBatch } from "../netlify-cell-api.js";

const provider = vi.hoisted(() => ({
	run: vi.fn(),
}));

vi.mock("@workspace/lib/providers", () => ({
	getProvider: () => ({ run: provider.run }),
	parseScrapeTargets: () => [
		{ model: "chatgpt", provider: "stub", version: "test", webSearch: false },
		{ model: "google-ai-mode", provider: "stub", version: "test", webSearch: false },
		{ model: "perplexity", provider: "stub", version: "test", webSearch: false },
	],
}));

import type { ProcessCellBatchData } from "./process-cell-batch.js";

const databaseUrl = process.env.ELMO_WORKER_TEST_DATABASE_URL;
if (process.env.ELMO_WORKER_TEST_REQUIRED === "1" && !databaseUrl) {
	throw new Error("ELMO_WORKER_TEST_DATABASE_URL is required for this test run");
}
if (databaseUrl) {
	const parsed = new URL(databaseUrl);
	if (
		process.env.ELMO_WORKER_TEST_DISPOSABLE_DATABASE !== "1" ||
		!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
		parsed.username !== "postgres" ||
		parsed.pathname !== "/elmo_test"
	) {
		throw new Error(
			"ELMO_WORKER_TEST_DATABASE_URL must identify the explicitly opted-in disposable local test database",
		);
	}
	process.env.DATABASE_URL = databaseUrl;
}
let processCellBatchJob: typeof import("./process-cell-batch.js").processCellBatchJob;
let processNetlifyCellBatch: typeof import("./process-cell-batch.js").processNetlifyCellBatch;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const targetRef = "dyrep-org";
const brandWebsite = "https://dyrep.org";
const successfulResult = {
	textContent: "DyReP result",
	rawOutput: {},
	webQueries: [],
	citations: [],
	modelVersion: "test-model",
};
const coordinates = [0, 1].flatMap((queryOrdinal) =>
	["chatgpt-search", "google-ai", "perplexity"].flatMap((surface, surfaceOrdinal) =>
		[1, 2].map((repetition) => ({ queryOrdinal, surface, surfaceOrdinal, repetition })),
	),
);

function job(batchId: string): Job<ProcessCellBatchData>[] {
	return [{ data: { batchId } }] as Job<ProcessCellBatchData>[];
}

databaseDescribe("processCellBatchJob database lifecycle", () => {
	let pool: Pool;

	beforeAll(async () => {
		({ processCellBatchJob } = await import("./process-cell-batch.js"));
		({ processNetlifyCellBatch } = await import("./process-cell-batch.js"));
		pool = new Pool({ connectionString: databaseUrl });
		const identity = await pool.query("select current_database() database, current_user username");
		expect(identity.rows[0]).toEqual({ database: "elmo_test", username: "postgres" });
		const tables = await pool.query(
			"select to_regclass('public.cell_batches') batches, to_regclass('public.cell_batch_cells') cells",
		);
		expect(tables.rows[0]).toEqual({ batches: "cell_batches", cells: "cell_batch_cells" });
	});

	afterAll(async () => {
		await pool.end();
	});

	beforeEach(async () => {
		process.env.DYREP_GEO_TARGET_REF = targetRef;
		delete process.env.DYREP_GEO_EXECUTION_MODE;
		provider.run.mockReset();
		provider.run.mockResolvedValue(successfulResult);
		await pool.query("truncate table cell_batch_cells, cell_batches restart identity cascade");
	});

	async function seedBatch(
		options: {
			batchStatus?: "pending" | "processing" | "completed" | "failed";
			cellStatuses?: Array<"pending" | "running" | "complete" | "failed">;
		} = {},
	): Promise<string> {
		const batch = await pool.query(
			`insert into cell_batches (
				target_ref, brand_name, brand_website, idempotency_key, request_hash, request_body, status
			) values ($1, 'DyReP', $2, $3, $4, $5::json, $6) returning id`,
			[
				targetRef,
				brandWebsite,
				`test:${randomUUID()}`,
				`sha256:${"a".repeat(64)}`,
				{ targetRef, brandWebsite },
				options.batchStatus ?? "pending",
			],
		);
		const batchId = batch.rows[0].id as string;
		for (const [index, coordinate] of coordinates.entries()) {
			const { queryOrdinal, surface, surfaceOrdinal, repetition } = coordinate;
			const model =
				surface === "chatgpt-search" ? "chatgpt" : surface === "google-ai" ? "google-ai-mode" : "perplexity";
			const status = options.cellStatuses?.[index] ?? "pending";
			await pool.query(
				`insert into cell_batch_cells (
					batch_id, query_ref, query_text, query_ordinal, surface, surface_ordinal,
					repetition, provider, model, status
				) values ($1, $2, $3, $4, $5, $6, $7, 'stub', $8, $9)`,
				[
					batchId,
					`query-${queryOrdinal + 1}`,
					`Question ${queryOrdinal + 1}`,
					queryOrdinal,
					surface,
					surfaceOrdinal,
					repetition,
					model,
					status,
				],
			);
		}
		return batchId;
	}

	async function state(batchId: string) {
		const batch = await pool.query("select status from cell_batches where id = $1", [batchId]);
		const cells = await pool.query(
			"select status, error_code from cell_batch_cells where batch_id = $1 order by query_ordinal, surface_ordinal, repetition, id",
			[batchId],
		);
		return {
			batch: batch.rows[0].status as string,
			cells: cells.rows as Array<{ status: string; error_code: string | null }>,
		};
	}

	it("Netlify API atomically creates twelve cells, replays and exports the processed batch", async () => {
		process.env.DYREP_GEO_EXECUTION_MODE = "netlify";
		const normalized = normalizeCellBatchRequest({
			targetRef,
			brandName: "DyReP",
			brandWebsite,
			queries: [1, 2].map((index) => ({ queryRef: `query-${index}`, text: `Question ${index}` })),
			surfaces: ["chatgpt-search", "google-ai", "perplexity"],
			repetitions: 2,
		});
		const binding = { batchId: randomUUID(), requestHash: normalized.requestHash };
		const configs = ["chatgpt", "google-ai-mode", "perplexity"].map((model) => ({
			model,
			provider: "stub",
			webSearch: false,
		}));
		const results = await Promise.all([
			createNetlifyBatch(normalized.body, "test:api-key", binding, configs),
			createNetlifyBatch(normalized.body, "test:api-key", binding, configs),
		]);
		expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
		expect((await readNetlifyBatch(binding, 1, 7)).pagination.total).toBe(12);
		await expect(createNetlifyBatch(normalized.body, "test:other-key", binding, configs)).rejects.toThrow(
			"idempotency_conflict",
		);
		await expect(
			createNetlifyBatch({ ...normalized.body, brandName: "Other" }, "test:api-key", binding, configs),
		).rejects.toThrow("request_binding_mismatch");
		expect(await processNetlifyCellBatch(binding.batchId, binding.requestHash)).toBe("processed");
		const first = await readNetlifyBatch(binding, 1, 7);
		const second = await readNetlifyBatch(binding, 2, 7);
		expect(first.status).toBe("completed");
		expect([...first.cells, ...second.cells]).toHaveLength(12);
		expect(first.cells.every((cell) => cell.status === "complete" && cell.observedAt)).toBe(true);
		await expect(readNetlifyBatch({ ...binding, requestHash: `sha256:${"b".repeat(64)}` }, 1, 100)).rejects.toThrow(
			"batch_not_found",
		);
		await expect(readNetlifyBatch(binding, 0, 100)).rejects.toThrow("invalid_pagination");
	});

	it("Netlify concurrent delivery and replay execute one twelve-cell batch", async () => {
		process.env.DYREP_GEO_EXECUTION_MODE = "netlify";
		const batchId = await seedBatch();
		const normalized = normalizeCellBatchRequest({
			targetRef,
			brandName: "DyReP",
			brandWebsite,
			queries: [1, 2].map((index) => ({ queryRef: `query-${index}`, text: `Question ${index}` })),
			surfaces: ["chatgpt-search", "google-ai", "perplexity"],
			repetitions: 2,
		});
		await pool.query("update cell_batches set request_body=$2::json,request_hash=$3 where id=$1", [
			batchId,
			normalized.body,
			normalized.requestHash,
		]);
		const results = await Promise.all([
			processNetlifyCellBatch(batchId, normalized.requestHash),
			processNetlifyCellBatch(batchId, normalized.requestHash),
		]);
		expect(results.sort()).toEqual(["not_claimed", "processed"]);
		expect(provider.run).toHaveBeenCalledTimes(12);
		expect(await processNetlifyCellBatch(batchId, normalized.requestHash)).toBe("not_claimed");
		expect(provider.run).toHaveBeenCalledTimes(12);
		expect((await state(batchId)).batch).toBe("completed");
	});

	it("Netlify leaves processing cells untouched and disables queue execution", async () => {
		process.env.DYREP_GEO_EXECUTION_MODE = "netlify";
		const batchId = await seedBatch({ batchStatus: "processing", cellStatuses: Array(12).fill("running") });
		expect(await processNetlifyCellBatch(batchId, `sha256:${"a".repeat(64)}`)).toBe("not_claimed");
		await processCellBatchJob(job(batchId));
		expect((await state(batchId)).cells.every((cell) => cell.status === "running")).toBe(true);
		expect(provider.run).not.toHaveBeenCalled();
	});

	it.each(["failed", "completed"] as const)("keeps a %s batch terminal on redelivery", async (terminalStatus) => {
		const cellStatus = terminalStatus === "completed" ? "complete" : "failed";
		const batchId = await seedBatch({ batchStatus: terminalStatus, cellStatuses: Array(12).fill(cellStatus) });
		await processCellBatchJob(job(batchId));
		expect((await state(batchId)).batch).toBe(terminalStatus);
		expect(provider.run).not.toHaveBeenCalled();
	});

	it("does not reclaim a batch that becomes terminal after the initial read", async () => {
		const batchId = await seedBatch();
		const blocker = await pool.connect();
		try {
			await blocker.query("begin");
			await blocker.query("select id from cell_batches where id = $1 for update", [batchId]);
			const processing = processCellBatchJob(job(batchId));
			await new Promise((resolve) => setTimeout(resolve, 150));
			await blocker.query(
				"update cell_batches set status = 'failed', completed_at = now(), updated_at = now() where id = $1",
				[batchId],
			);
			await blocker.query("commit");
			await processing;
		} finally {
			await blocker.query("rollback").catch(() => undefined);
			blocker.release();
		}
		expect((await state(batchId)).batch).toBe("failed");
		expect(provider.run).not.toHaveBeenCalled();
	});

	it("stops before the next provider call when a concurrent writer terminalizes the batch", async () => {
		const batchId = await seedBatch();
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerRelease = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		provider.run.mockImplementationOnce(async () => {
			markProviderStarted();
			await providerRelease;
			return successfulResult;
		});
		const processing = processCellBatchJob(job(batchId));
		await providerStarted;
		await pool.query(
			"update cell_batches set status = 'failed', completed_at = now(), updated_at = now() where id = $1",
			[batchId],
		);
		releaseProvider();
		await processing;
		expect((await state(batchId)).batch).toBe("failed");
		expect(provider.run).toHaveBeenCalledTimes(1);
	});

	it("turns a running cell left by a crash into an explicit failed outcome", async () => {
		const batchId = await seedBatch({
			batchStatus: "processing",
			cellStatuses: ["running", ...Array(11).fill("pending")],
		});
		await processCellBatchJob(job(batchId));
		const result = await state(batchId);
		expect(result.batch).toBe("failed");
		expect(result.cells[0]).toEqual({ status: "failed", error_code: "outcome_unknown_after_worker_restart" });
		expect(result.cells.slice(1).every(({ status }) => status === "complete")).toBe(true);
		expect(provider.run).toHaveBeenCalledTimes(11);
	});

	it("fails closed when the deployment target flips between provider calls", async () => {
		const batchId = await seedBatch();
		provider.run.mockImplementationOnce(async () => {
			process.env.DYREP_GEO_TARGET_REF = "rob-concepting-nl";
			return successfulResult;
		});
		await processCellBatchJob(job(batchId));
		const result = await state(batchId);
		expect(result.batch).toBe("failed");
		expect(result.cells.filter(({ status }) => status === "complete")).toHaveLength(1);
		expect(result.cells.filter(({ status }) => status === "failed")).toHaveLength(11);
		expect(provider.run).toHaveBeenCalledTimes(1);
	});

	it("keeps the batch non-green when a provider call fails", async () => {
		const batchId = await seedBatch();
		provider.run.mockRejectedValueOnce(new Error("provider unavailable"));
		await processCellBatchJob(job(batchId));
		const result = await state(batchId);
		expect(result.batch).toBe("failed");
		expect(result.cells.filter(({ error_code }) => error_code === "provider_call_failed")).toHaveLength(1);
		expect(result.cells.filter(({ status }) => status === "complete")).toHaveLength(11);
		expect(provider.run).toHaveBeenCalledTimes(12);
	});

	it("marks only a full 12/12 successful matrix completed", async () => {
		const batchId = await seedBatch();
		await processCellBatchJob(job(batchId));
		const result = await state(batchId);
		expect(result.batch).toBe("completed");
		expect(result.cells.every(({ status }) => status === "complete")).toBe(true);
		expect(provider.run).toHaveBeenCalledTimes(12);
	});
});
