import { normalizeCellBatchRequest, planCellCoordinates, resolveCellSurfaceConfigs } from "@workspace/lib/cell-batches";
import { db } from "@workspace/lib/db/db";
import { cellBatchCells, cellBatches } from "@workspace/lib/db/schema";
import type { ModelConfig } from "@workspace/lib/providers";
import { and, asc, eq } from "drizzle-orm";

export interface BatchBinding {
	batchId: string;
	requestHash: string;
}
const wireStatus = (status: string) => (status === "processing" ? "running" : status);

export async function createNetlifyBatch(body: unknown, key: string, binding: BatchBinding, configs: ModelConfig[]) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) throw new Error("invalid_idempotency_key");
	const normalized = normalizeCellBatchRequest(body);
	if (normalized.body.targetRef !== "dyrep-org" || normalized.requestHash !== binding.requestHash) {
		throw new Error("request_binding_mismatch");
	}
	const planned = planCellCoordinates(normalized.body, resolveCellSurfaceConfigs(configs));
	return db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(cellBatches)
			.values({
				id: binding.batchId,
				targetRef: "dyrep-org",
				brandName: normalized.body.brandName,
				brandWebsite: normalized.body.brandWebsite,
				idempotencyKey: key,
				requestHash: normalized.requestHash,
				requestBody: normalized.body,
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted) {
			const [existing] = await tx.select().from(cellBatches).where(eq(cellBatches.id, binding.batchId)).limit(1);
			if (
				existing?.targetRef !== "dyrep-org" ||
				existing.requestHash !== binding.requestHash ||
				existing.idempotencyKey !== key
			)
				throw new Error("idempotency_conflict");
			return {
				batchId: existing.id,
				targetRef: existing.targetRef,
				status: wireStatus(existing.status),
				requestHash: existing.requestHash,
				idempotentReplay: true,
			};
		}
		await tx.insert(cellBatchCells).values(planned.map((cell) => ({ ...cell, batchId: inserted.id })));
		return {
			batchId: inserted.id,
			targetRef: inserted.targetRef,
			status: wireStatus(inserted.status),
			requestHash: inserted.requestHash,
			idempotentReplay: false,
		};
	});
}

export async function readNetlifyBatch(binding: BatchBinding, page: number, limit: number) {
	if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("invalid_pagination");
	}
	const [batch] = await db
		.select()
		.from(cellBatches)
		.where(
			and(
				eq(cellBatches.id, binding.batchId),
				eq(cellBatches.targetRef, "dyrep-org"),
				eq(cellBatches.requestHash, binding.requestHash),
			),
		)
		.limit(1);
	if (!batch) throw new Error("batch_not_found");
	const all = await db
		.select()
		.from(cellBatchCells)
		.where(eq(cellBatchCells.batchId, batch.id))
		.orderBy(
			asc(cellBatchCells.queryOrdinal),
			asc(cellBatchCells.surfaceOrdinal),
			asc(cellBatchCells.repetition),
			asc(cellBatchCells.id),
		);
	return {
		batchId: batch.id,
		targetRef: batch.targetRef,
		status: wireStatus(batch.status),
		cells: all.slice((page - 1) * limit, page * limit).map((cell) => ({
			cellId: cell.id,
			queryRef: cell.queryRef,
			surface: cell.surface,
			repetition: cell.repetition,
			provider: cell.provider,
			model: cell.model,
			modelVersion: cell.modelVersion,
			probeModality: cell.probeModality,
			observedAt: cell.observedAt?.toISOString() ?? null,
			status: cell.status,
			text: cell.text,
			brandMentioned: cell.brandMentioned,
			citationsSupported: cell.citationsSupported,
			citations: cell.citations,
		})),
		pagination: { page, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) },
	};
}
