import { handleNetlifyCellBatch } from "../../src/netlify-cell-handler.js";

declare const Netlify: { env: { get: (name: string) => string | undefined } };

export default async (request: Request, context: { site: { id: string } }) => {
	if (context.site.id !== "1ac9542d-dc7c-4c22-be2c-0ad5d495fcd9") return;
	const status = await handleNetlifyCellBatch(
		request,
		{
			enabled: Netlify.env.get("DYREP_GEO_NETLIFY_EXECUTION_ENABLED"),
			token: Netlify.env.get("DYREP_GEO_NETLIFY_WORKER_TOKEN"),
			batchId: Netlify.env.get("DYREP_GEO_NETLIFY_BATCH_ID"),
			requestHash: Netlify.env.get("DYREP_GEO_NETLIFY_REQUEST_HASH"),
			target: Netlify.env.get("DYREP_GEO_TARGET_REF"),
		},
		async (batchId, requestHash) => {
			const { getProvider, parseScrapeTargets, resolveProviderAccess, validateScrapeTargets } = await import(
				"@workspace/lib/providers"
			);
			const { resolveCellSurfaceConfigs } = await import("@workspace/lib/cell-batches");
			const configs = parseScrapeTargets(Netlify.env.get("SCRAPE_TARGETS"));
			validateScrapeTargets(configs, getProvider);
			for (const config of resolveCellSurfaceConfigs(configs).values()) {
				if (config.provider !== "olostep" || config.version || resolveProviderAccess(config) !== "scraped") {
					throw new Error("netlify_consumer_provider_required");
				}
			}
			const { createOlostepBatchClient } = await import("../../src/olostep-batch-client.js");
			const provider = createOlostepBatchClient(Netlify.env.get("OLOSTEP_API_KEY") ?? "");
			const { db } = await import("@workspace/lib/db/db");
			const { runOlostepBatchStep } = await import("../../src/olostep-batch-step.js");
			return runOlostepBatchStep(db.$client, { batchId, requestHash }, provider);
		},
	);
	console.log(JSON.stringify({ event: "dyrep_cell_worker", status }));
};

export const config = { path: "/internal/geo/cell-batch" };
