import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { diagnosticBlobs } from "../../src/diagnostic-blobs.js";
import { createPerplexityDiagnosticClient } from "../../src/olostep-batch-client.js";
import { collectPerplexityDiagnostic, submitPerplexityDiagnostic } from "../../src/perplexity-diagnostic.js";

declare const Netlify: { env: { get: (name: string) => string | undefined } };
const response = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
export default async (request: Request, context: { site: { id: string } }) => {
	const token = Netlify.env.get("DYREP_GEO_NETLIFY_API_TOKEN");
	if (
		context.site.id !== "1ac9542d-dc7c-4c22-be2c-0ad5d495fcd9" ||
		Netlify.env.get("DYREP_GEO_TARGET_REF") !== "dyrep-org" ||
		!token ||
		token.length < 32
	)
		return response({ status: "unavailable" }, 503);
	const digest = (s: string) => createHash("sha256").update(s).digest();
	if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`)))
		return response({ status: "unauthorized" }, 401);
	const action = new URL(request.url).pathname.split("/").at(-1);
	if (request.method !== "POST" || !["preflight", "submit", "collect"].includes(action ?? "") || request.body !== null)
		return response({ status: "invalid_request" }, 400);
	const store = getStore({ name: "dyrep-perplexity-diagnostic-20260908", consistency: "strong" });
	const journal = diagnosticBlobs({
		set: (key, value, options) => store.set(key, value, options),
		get: (key) => store.get(key, { type: "text" }),
	});
	try {
		if (action === "preflight") {
			const key = `storage-proof/${randomUUID()}`;
			const results = await Promise.all([
				store.set(key, "proof", { onlyIfNew: true }),
				store.set(key, "proof", { onlyIfNew: true }),
			]);
			const ready =
				results.filter((r) => r.modified).length === 1 && (await store.get(key, { type: "text" })) === "proof";
			return response({ status: ready ? "storage_ready" : "storage_failed", provider_posts: 0 }, ready ? 200 : 503);
		}
		const provider = createPerplexityDiagnosticClient(Netlify.env.get("OLOSTEP_API_KEY") ?? "");
		return response(
			action === "submit"
				? await submitPerplexityDiagnostic(journal, provider)
				: await collectPerplexityDiagnostic(journal, provider),
		);
	} catch {
		return response({ status: "diagnostic_stopped", automatic_resubmit: false }, 409);
	}
};
export const config = { path: "/internal/geo/perplexity-diagnostic/*" };
