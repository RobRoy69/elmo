import {
	executeCellBatchTargetBound,
	normalizeCellBatchRequest,
	recoveryAction,
	resolveCellSurfaceConfigs,
	validateCellBatchTargetBinding,
} from "@workspace/lib/cell-batches";
import { db } from "@workspace/lib/db/db";
import { cellBatchCells, cellBatches } from "@workspace/lib/db/schema";
import { getProvider, parseScrapeTargets } from "@workspace/lib/providers";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Job } from "pg-boss";

export interface ProcessCellBatchData {
	batchId: string;
}

type CellBatch = typeof cellBatches.$inferSelect;
type CellBatchCell = typeof cellBatchCells.$inferSelect;
type SurfaceConfigs = ReturnType<typeof resolveCellSurfaceConfigs>;

function mentioned(text: string, brandName: string, brandWebsite: string): boolean {
	const normalized = text.toLowerCase();
	const domain = new URL(brandWebsite).hostname.replace(/^www\./, "").toLowerCase();
	return normalized.includes(brandName.toLowerCase()) || normalized.includes(domain);
}

async function prepareBatch(batchId: string, startedAt: Date): Promise<boolean> {
	return db.transaction(async (tx) => {
		const claimed = await tx
			.update(cellBatches)
			.set({ status: "processing", updatedAt: startedAt })
			.where(and(eq(cellBatches.id, batchId), inArray(cellBatches.status, ["pending", "processing"])))
			.returning({ id: cellBatches.id });
		if (claimed.length !== 1) return false;
		// A retry never repeats an ambiguous paid call. A cell left running by a
		// dead worker becomes an explicit failed outcome and remains in 12/12.
		await tx
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: "outcome_unknown",
				brandMentioned: false,
				observedAt: startedAt,
				errorCode: "outcome_unknown_after_worker_restart",
				updatedAt: startedAt,
			})
			.where(and(eq(cellBatchCells.batchId, batchId), eq(cellBatchCells.status, "running")));
		return true;
	});
}

async function failBatch(batchId: string, errorCode: string): Promise<void> {
	const now = new Date();
	await db.transaction(async (tx) => {
		const failed = await tx
			.update(cellBatches)
			.set({ status: "failed", completedAt: now, updatedAt: now })
			.where(and(eq(cellBatches.id, batchId), inArray(cellBatches.status, ["pending", "processing"])))
			.returning({ id: cellBatches.id });
		if (failed.length !== 1) return;
		await tx
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: "outcome_unknown",
				brandMentioned: false,
				observedAt: now,
				errorCode: "outcome_unknown_after_worker_restart",
				updatedAt: now,
			})
			.where(and(eq(cellBatchCells.batchId, batchId), eq(cellBatchCells.status, "running")));
		await tx
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: "not_executed",
				brandMentioned: false,
				observedAt: now,
				errorCode,
				updatedAt: now,
			})
			.where(and(eq(cellBatchCells.batchId, batchId), eq(cellBatchCells.status, "pending")));
	});
}

async function processCell(
	cell: CellBatchCell,
	batch: CellBatch,
	configs: SurfaceConfigs,
): Promise<"continue" | "target_binding_failed"> {
	const action = recoveryAction(cell.status);
	if (action === "keep_terminal") return "continue";
	if (action === "fail_outcome_unknown") {
		const observedAt = new Date();
		await db
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: "outcome_unknown",
				brandMentioned: false,
				observedAt,
				errorCode: "outcome_unknown_after_worker_restart",
				updatedAt: observedAt,
			})
			.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
		return "continue";
	}
	const config = configs.get(cell.surface);
	if (!config || config.model !== cell.model || config.provider !== cell.provider) {
		const observedAt = new Date();
		await db
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: "binding_drift",
				brandMentioned: false,
				observedAt,
				errorCode: "surface_binding_drift",
				updatedAt: observedAt,
			})
			.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "pending")));
		return "continue";
	}

	const claimed = await db
		.update(cellBatchCells)
		.set({ status: "running", updatedAt: new Date() })
		.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "pending")))
		.returning();
	if (claimed.length !== 1) return "continue";

	try {
		const execution = await executeCellBatchTargetBound(
			process.env.DYREP_GEO_TARGET_REF,
			batch.targetRef,
			batch.brandWebsite,
			() =>
				getProvider(config.provider).run(config.model, cell.queryText, {
					webSearch: config.webSearch,
					version: config.version,
				}),
		);
		if (!execution.ok) {
			const observedAt = new Date();
			await db
				.update(cellBatchCells)
				.set({
					status: "failed",
					modelVersion: "not_executed",
					brandMentioned: false,
					observedAt,
					errorCode: execution.bindingFailure,
					updatedAt: observedAt,
				})
				.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
			return "target_binding_failed";
		}
		const result = execution.value;
		const observedAt = new Date();
		await db
			.update(cellBatchCells)
			.set({
				status: "complete",
				modelVersion: result.modelVersion ?? config.version ?? config.provider,
				text: result.textContent,
				brandMentioned: mentioned(result.textContent, batch.brandName, batch.brandWebsite),
				citationsSupported: true,
				citations: result.citations,
				observedAt,
				errorCode: null,
				updatedAt: observedAt,
			})
			.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
	} catch {
		const observedAt = new Date();
		await db
			.update(cellBatchCells)
			.set({
				status: "failed",
				modelVersion: config.version ?? config.provider,
				brandMentioned: false,
				citationsSupported: true,
				citations: [],
				observedAt,
				errorCode: "provider_call_failed",
				updatedAt: observedAt,
			})
			.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
	}
	return "continue";
}

async function finalizeBatch(batchId: string): Promise<void> {
	const terminal = await db
		.select({ status: cellBatchCells.status })
		.from(cellBatchCells)
		.where(eq(cellBatchCells.batchId, batchId));
	const now = new Date();
	await db
		.update(cellBatches)
		.set({
			status: terminal.length === 12 && terminal.every(({ status }) => status === "complete") ? "completed" : "failed",
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(cellBatches.id, batchId), eq(cellBatches.status, "processing")));
}

async function processBatch(
	batch: CellBatch,
	configs: SurfaceConfigs,
	claimed = false,
	deadline = Infinity,
): Promise<void> {
	if (!claimed && !(await prepareBatch(batch.id, new Date()))) return;
	const bindingFailure = validateCellBatchTargetBinding(
		process.env.DYREP_GEO_TARGET_REF,
		batch.targetRef,
		batch.brandWebsite,
	);
	if (bindingFailure) {
		await failBatch(batch.id, bindingFailure);
		return;
	}
	const cells = await db
		.select()
		.from(cellBatchCells)
		.where(eq(cellBatchCells.batchId, batch.id))
		.orderBy(
			asc(cellBatchCells.queryOrdinal),
			asc(cellBatchCells.surfaceOrdinal),
			asc(cellBatchCells.repetition),
			asc(cellBatchCells.id),
		);
	if (cells.length !== 12) {
		await failBatch(batch.id, "invalid_cell_count");
		return;
	}
	for (const cell of cells) {
		if (Date.now() >= deadline) {
			await failBatch(batch.id, "execution_deadline_reached");
			return;
		}
		const [current] = await db
			.select({ status: cellBatches.status })
			.from(cellBatches)
			.where(eq(cellBatches.id, batch.id))
			.limit(1);
		if (current?.status !== "processing") return;
		if ((await processCell(cell, batch, configs)) === "target_binding_failed") {
			await failBatch(batch.id, "target_binding_changed");
			return;
		}
	}
	await finalizeBatch(batch.id);
}

export async function processNetlifyCellBatch(batchId: string, requestHash: string): Promise<string> {
	if (process.env.DYREP_GEO_EXECUTION_MODE !== "netlify") throw new Error("netlify_execution_mode_required");
	const [batch] = await db.select().from(cellBatches).where(eq(cellBatches.id, batchId)).limit(1);
	if (batch?.status !== "pending") return "not_claimed";
	if (
		batch.targetRef !== "dyrep-org" ||
		batch.requestHash !== requestHash ||
		validateCellBatchTargetBinding(process.env.DYREP_GEO_TARGET_REF, batch.targetRef, batch.brandWebsite)
	) {
		throw new Error("netlify_batch_binding_invalid");
	}
	const normalized = normalizeCellBatchRequest(batch.requestBody);
	if (normalized.requestHash !== requestHash) throw new Error("netlify_batch_request_hash_invalid");
	const configs = resolveCellSurfaceConfigs(parseScrapeTargets(process.env.SCRAPE_TARGETS));
	// Netlify can deliver concurrently or retry after a timeout. Only pending is
	// claimable; processing requires explicit reconciliation, never paid replay.
	const claimed = await db
		.update(cellBatches)
		.set({ status: "processing", updatedAt: new Date() })
		.where(
			and(
				eq(cellBatches.id, batchId),
				eq(cellBatches.status, "pending"),
				eq(cellBatches.targetRef, "dyrep-org"),
				eq(cellBatches.requestHash, requestHash),
			),
		)
		.returning();
	if (claimed.length !== 1) return "not_claimed";
	try {
		await processBatch(claimed[0], configs, true, Date.now() + 12 * 60_000);
	} catch {
		await failBatch(batchId, "netlify_execution_outcome_unknown");
		throw new Error("netlify_batch_execution_failed");
	}
	return "processed";
}

export async function processCellBatchJob(jobs: Job<ProcessCellBatchData>[]): Promise<void> {
	if (process.env.DYREP_GEO_EXECUTION_MODE === "netlify") return;
	let configs: SurfaceConfigs | undefined;
	for (const job of jobs) {
		const [batch] = await db.select().from(cellBatches).where(eq(cellBatches.id, job.data.batchId)).limit(1);
		if (!batch || batch.status === "completed" || batch.status === "failed") continue;
		const bindingFailure = validateCellBatchTargetBinding(
			process.env.DYREP_GEO_TARGET_REF,
			batch.targetRef,
			batch.brandWebsite,
		);
		if (bindingFailure) {
			await failBatch(batch.id, bindingFailure);
			continue;
		}
		configs ??= resolveCellSurfaceConfigs(parseScrapeTargets(process.env.SCRAPE_TARGETS));
		await processBatch(batch, configs);
	}
}
