import { createFileRoute } from "@tanstack/react-router";
import {
	cellBatchRequestSchema,
	normalizeCellBatchRequest,
	planCellCoordinates,
	resolveCellBatchIdempotency,
	resolveCellSurfaceConfigs,
	validateCellBatchTargetBinding,
} from "@workspace/lib/cell-batches";
import { db } from "@workspace/lib/db/db";
import { cellBatchCells, cellBatches } from "@workspace/lib/db/schema";
import { parseScrapeTargets } from "@workspace/lib/providers";
import { and, eq } from "drizzle-orm";
import { ApiError, createApiHandler } from "@/lib/api/handler";
import { sendCellBatchJob } from "@/lib/job-scheduler";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export const Route = createFileRoute("/api/v1/cell-batches/")({
	server: {
		handlers: {
			POST: createApiHandler({
				body: cellBatchRequestSchema,
				handle: async ({ body, request }) => {
					const idempotencyKey = request.headers.get("idempotency-key");
					if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
						throw new ApiError(400, "Validation Error", "A valid Idempotency-Key is required");
					}
					let website: URL;
					try {
						website = new URL(body.brandWebsite);
					} catch {
						throw new ApiError(400, "Validation Error", "brandWebsite must be a valid HTTPS URL");
					}
					if (website.protocol !== "https:" || website.username || website.password) {
						throw new ApiError(400, "Validation Error", "brandWebsite must be a credential-free HTTPS URL");
					}
					const deploymentTarget = process.env.DYREP_GEO_TARGET_REF;
					if (!deploymentTarget) throw new ApiError(503, "Unavailable", "Deployment target is not configured");
					const bindingFailure = validateCellBatchTargetBinding(deploymentTarget, body.targetRef, body.brandWebsite);
					if (bindingFailure === "deployment_target_invalid") {
						throw new ApiError(503, "Unavailable", "Deployment target is invalid");
					}
					if (bindingFailure === "target_mismatch") {
						throw new ApiError(403, "target_mismatch", "Target differs from deployment");
					}
					if (bindingFailure === "target_website_mismatch") {
						throw new ApiError(403, "target_website_mismatch", "Website differs from target configuration");
					}
					const normalized = normalizeCellBatchRequest(body);
					const configs = resolveCellSurfaceConfigs(parseScrapeTargets(process.env.SCRAPE_TARGETS));
					const planned = planCellCoordinates(normalized.body, configs);

					const result = await db.transaction(async (tx) => {
						const inserted = await tx
							.insert(cellBatches)
							.values({
								targetRef: normalized.body.targetRef,
								brandName: normalized.body.brandName,
								brandWebsite: normalized.body.brandWebsite,
								idempotencyKey,
								requestHash: normalized.requestHash,
								requestBody: normalized.body,
							})
							.onConflictDoNothing({ target: cellBatches.idempotencyKey })
							.returning();

						if (inserted.length === 0) {
							const [existing] = await tx
								.select()
								.from(cellBatches)
								.where(eq(cellBatches.idempotencyKey, idempotencyKey))
								.limit(1);
							if (!existing) throw new ApiError(503, "Unavailable", "Idempotency state was not readable");
							try {
								resolveCellBatchIdempotency(existing.requestHash, normalized.requestHash);
							} catch {
								throw new ApiError(409, "idempotency_conflict", "Idempotency-Key belongs to a different request");
							}
							return { batch: existing, created: false };
						}

						const batch = inserted[0];
						await tx.insert(cellBatchCells).values(planned.map((cell) => ({ ...cell, batchId: batch.id })));
						return { batch, created: true };
					});

					// Replaying a still-pending row repairs a crash between DB commit and
					// queue send. pg-boss singletonKey makes the send itself idempotent.
					if ((result.created || result.batch.status === "pending") && !(await sendCellBatchJob(result.batch.id))) {
						const now = new Date();
						await db.transaction(async (tx) => {
							await tx
								.update(cellBatches)
								.set({ status: "failed", completedAt: now, updatedAt: now })
								.where(eq(cellBatches.id, result.batch.id));
							await tx
								.update(cellBatchCells)
								.set({
									status: "failed",
									modelVersion: "not_executed",
									brandMentioned: false,
									observedAt: now,
									errorCode: "queue_failed",
									updatedAt: now,
								})
								.where(and(eq(cellBatchCells.batchId, result.batch.id), eq(cellBatchCells.status, "pending")));
						});
						throw new ApiError(500, "Internal Server Error", "Failed to queue cell batch");
					}

					return Response.json(
						{
							batchId: result.batch.id,
							targetRef: result.batch.targetRef,
							status: result.batch.status,
							requestHash: result.batch.requestHash,
							idempotentReplay: !result.created,
						},
						{ status: result.created ? 201 : 200 },
					);
				},
			}),
		},
	},
});
