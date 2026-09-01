import { resolveCellSurfaceConfigs } from "@workspace/lib/cell-batches";
import { db } from "@workspace/lib/db/db";
import { cellBatchCells, cellBatches } from "@workspace/lib/db/schema";
import { getProvider, parseScrapeTargets } from "@workspace/lib/providers";
import { and, asc, eq } from "drizzle-orm";
import type { Job } from "pg-boss";

export interface ProcessCellBatchData { batchId: string }

function mentioned(text: string, brandName: string, brandWebsite: string): boolean {
	const normalized = text.toLowerCase();
	const domain = new URL(brandWebsite).hostname.replace(/^www\./, "").toLowerCase();
	return normalized.includes(brandName.toLowerCase()) || normalized.includes(domain);
}

export async function processCellBatchJob(jobs: Job<ProcessCellBatchData>[]): Promise<void> {
	const configs = resolveCellSurfaceConfigs(parseScrapeTargets(process.env.SCRAPE_TARGETS));
	for (const job of jobs) {
		const [batch] = await db.select().from(cellBatches).where(eq(cellBatches.id, job.data.batchId)).limit(1);
		if (!batch || batch.status === "completed") continue;
		const startedAt = new Date();
		await db.transaction(async (tx) => {
			// A retry never repeats an ambiguous paid call. A cell left running by a
			// dead worker becomes an explicit failed outcome and remains in 12/12.
			await tx.update(cellBatchCells).set({
				status: "failed", modelVersion: "outcome_unknown", brandMentioned: false,
				observedAt: startedAt, errorCode: "outcome_unknown_after_worker_restart", updatedAt: startedAt,
			}).where(and(eq(cellBatchCells.batchId, batch.id), eq(cellBatchCells.status, "running")));
			await tx.update(cellBatches).set({ status: "processing", updatedAt: startedAt })
				.where(eq(cellBatches.id, batch.id));
		});

		const cells = await db.select().from(cellBatchCells).where(eq(cellBatchCells.batchId, batch.id))
			.orderBy(asc(cellBatchCells.queryOrdinal), asc(cellBatchCells.surfaceOrdinal),
				asc(cellBatchCells.repetition), asc(cellBatchCells.id));
		if (cells.length !== 12) {
			await db.update(cellBatches).set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
				.where(eq(cellBatches.id, batch.id));
			continue;
		}

		for (const cell of cells) {
			if (cell.status !== "pending") continue;
			const config = configs.get(cell.surface);
			if (!config || config.model !== cell.model || config.provider !== cell.provider) {
				await db.update(cellBatchCells).set({
					status: "failed", modelVersion: "binding_drift", brandMentioned: false,
					observedAt: new Date(), errorCode: "surface_binding_drift", updatedAt: new Date(),
				}).where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "pending")));
				continue;
			}
			const claimed = await db.update(cellBatchCells).set({ status: "running", updatedAt: new Date() })
				.where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "pending"))).returning();
			if (claimed.length !== 1) continue;
			try {
				const result = await getProvider(config.provider).run(config.model, cell.queryText, {
					webSearch: config.webSearch, version: config.version,
				});
				const observedAt = new Date();
				await db.update(cellBatchCells).set({
					status: "complete",
					modelVersion: result.modelVersion ?? config.version ?? config.provider,
					text: result.textContent,
					brandMentioned: mentioned(result.textContent, batch.brandName, batch.brandWebsite),
					citationsSupported: true,
					citations: result.citations,
					observedAt,
					errorCode: null,
					updatedAt: observedAt,
				}).where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
			} catch {
				const observedAt = new Date();
				await db.update(cellBatchCells).set({
					status: "failed", modelVersion: config.version ?? config.provider, brandMentioned: false,
					citationsSupported: true, citations: [], observedAt,
					errorCode: "provider_call_failed", updatedAt: observedAt,
				}).where(and(eq(cellBatchCells.id, cell.id), eq(cellBatchCells.status, "running")));
			}
		}

		const terminal = await db.select({ status: cellBatchCells.status }).from(cellBatchCells)
			.where(eq(cellBatchCells.batchId, batch.id));
		const now = new Date();
		await db.update(cellBatches).set({
			status: terminal.length === 12 && terminal.every(({ status }) => status === "complete" || status === "failed")
				? "completed" : "failed",
			completedAt: now,
			updatedAt: now,
		}).where(eq(cellBatches.id, batch.id));
	}
}
