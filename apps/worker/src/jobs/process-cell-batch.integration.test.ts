import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { type ProcessCellBatchData, processCellBatchJob } from "./process-cell-batch";

const databaseUrl = process.env.DATABASE_URL;
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
		pool = new Pool({ connectionString: databaseUrl });
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

	it.each(["failed", "completed"] as const)("keeps a %s batch terminal on redelivery", async (terminalStatus) => {
		const cellStatus = terminalStatus === "completed" ? "complete" : "failed";
		const batchId = await seedBatch({ batchStatus: terminalStatus, cellStatuses: Array(12).fill(cellStatus) });
		await processCellBatchJob(job(batchId));
		expect((await state(batchId)).batch).toBe(terminalStatus);
		expect(provider.run).not.toHaveBeenCalled();
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
