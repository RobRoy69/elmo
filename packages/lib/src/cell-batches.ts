import { createHash } from "node:crypto";
import type { ModelConfig } from "@workspace/config/scrape-targets";
import { z } from "zod";

export const DYREP_CELL_SURFACES = ["chatgpt-search", "google-ai", "perplexity"] as const;
export const DYREP_CELL_TARGETS = [
	"dyrep-org", "rob-concepting-nl", "itjing-praktijk-nl", "iching-practice-en",
] as const;
export const DYREP_SURFACE_MODELS: Readonly<Record<(typeof DYREP_CELL_SURFACES)[number], string>> = Object.freeze({
	"chatgpt-search": "chatgpt",
	"google-ai": "google-ai-mode",
	perplexity: "perplexity",
});

const ref = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const query = z.object({ queryRef: ref, text: z.string().trim().min(1).max(10_000) }).strict();
export const cellBatchRequestSchema = z.object({
	targetRef: z.enum(DYREP_CELL_TARGETS),
	brandName: z.string().trim().min(1).max(500),
	brandWebsite: z.string().trim().min(1).max(2_000),
	queries: z.array(query).length(2),
	surfaces: z.tuple([z.literal("chatgpt-search"), z.literal("google-ai"), z.literal("perplexity")]),
	repetitions: z.literal(2),
}).strict();

export type CellBatchRequest = z.infer<typeof cellBatchRequestSchema>;

export function resolveCellBatchIdempotency(existingHash: string | null, requestHash: string): "create" | "replay" {
	if (existingHash === null) return "create";
	if (existingHash === requestHash) return "replay";
	throw new Error("cell_batch_idempotency_conflict");
}

export function recoveryAction(status: "pending" | "running" | "complete" | "failed"):
	"execute" | "fail_outcome_unknown" | "keep_terminal" {
	if (status === "pending") return "execute";
	if (status === "running") return "fail_outcome_unknown";
	return "keep_terminal";
}

export function normalizeCellBatchRequest(value: unknown): { body: CellBatchRequest; json: string; requestHash: string } {
	const parsed = cellBatchRequestSchema.parse(value);
	if (new Set(parsed.queries.map(({ queryRef }) => queryRef)).size !== parsed.queries.length) {
		throw new Error("cell_batch_duplicate_query_ref");
	}
	const body: CellBatchRequest = {
		targetRef: parsed.targetRef,
		brandName: parsed.brandName,
		brandWebsite: parsed.brandWebsite,
		queries: parsed.queries.map(({ queryRef, text }) => ({ queryRef, text })),
		surfaces: ["chatgpt-search", "google-ai", "perplexity"],
		repetitions: 2,
	};
	const json = JSON.stringify(body);
	return { body, json, requestHash: `sha256:${createHash("sha256").update(json).digest("hex")}` };
}

export function resolveCellSurfaceConfigs(configs: ModelConfig[]): Map<string, ModelConfig> {
	const resolved = new Map<string, ModelConfig>();
	for (const surface of DYREP_CELL_SURFACES) {
		const matches = configs.filter(({ model }) => model === DYREP_SURFACE_MODELS[surface]);
		if (matches.length !== 1) throw new Error(`cell_batch_surface_binding_invalid:${surface}`);
		resolved.set(surface, Object.freeze({ ...matches[0] }));
	}
	return resolved;
}

export function planCellCoordinates(body: CellBatchRequest, configs: Map<string, ModelConfig>) {
	return body.queries.flatMap((queryItem, queryOrdinal) =>
		body.surfaces.flatMap((surface, surfaceOrdinal) => {
			const config = configs.get(surface);
			if (!config) throw new Error(`cell_batch_surface_binding_invalid:${surface}`);
			return [1, 2].map((repetition) => ({
				queryRef: queryItem.queryRef,
				queryText: queryItem.text,
				queryOrdinal,
				surface,
				surfaceOrdinal,
				repetition,
				provider: config.provider,
				model: config.model,
				probeModality: "consumer" as const,
			}));
		}),
	);
}
