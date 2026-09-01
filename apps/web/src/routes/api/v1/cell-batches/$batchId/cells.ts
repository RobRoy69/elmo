import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { cellBatchCells, cellBatches } from "@workspace/lib/db/schema";
import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, createApiHandler } from "@/lib/api/handler";

export const Route = createFileRoute("/api/v1/cell-batches/$batchId/cells")({
	server: {
		handlers: {
			GET: createApiHandler({
				params: z.object({ batchId: z.guid("Invalid batch ID format") }),
				handle: async ({ params, request }) => {
					const deploymentTarget = process.env.DYREP_GEO_TARGET_REF;
					if (!deploymentTarget) throw new ApiError(503, "Unavailable", "Deployment target is not configured");
					const [batch] = await db.select().from(cellBatches).where(eq(cellBatches.id, params.batchId)).limit(1);
					if (!batch || batch.targetRef !== deploymentTarget) {
						throw new ApiError(404, "Not Found", "Cell batch not found");
					}
					const { searchParams } = new URL(request.url);
					const pageValue = Number.parseInt(searchParams.get("page") ?? "1", 10);
					const limitValue = Number.parseInt(searchParams.get("limit") ?? "100", 10);
					const page = Number.isFinite(pageValue) ? Math.max(1, pageValue) : 1;
					const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 100;
					const [{ total }] = await db
						.select({ total: count() })
						.from(cellBatchCells)
						.where(eq(cellBatchCells.batchId, batch.id));
					const cells = await db
						.select()
						.from(cellBatchCells)
						.where(eq(cellBatchCells.batchId, batch.id))
						.orderBy(
							asc(cellBatchCells.queryOrdinal),
							asc(cellBatchCells.surfaceOrdinal),
							asc(cellBatchCells.repetition),
							asc(cellBatchCells.id),
						)
						.limit(limit)
						.offset((page - 1) * limit);

					return {
						batchId: batch.id,
						targetRef: batch.targetRef,
						status: batch.status,
						cells: cells.map((cell) => ({
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
						pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
					};
				},
			}),
		},
	},
});
