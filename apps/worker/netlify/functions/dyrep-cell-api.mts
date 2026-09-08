import { createHash, timingSafeEqual } from "node:crypto";
import { netlifyFailureReason } from "../../src/netlify-cell-errors.js";

declare const Netlify: { env: { get: (name: string) => string | undefined } };

async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("invalid_body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > 32768) {
			await reader.cancel();
			throw new Error("body_too_large");
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("invalid_body");
	}
}

function bindingSettings() {
	const token = Netlify.env.get("DYREP_GEO_NETLIFY_API_TOKEN");
	const batchId = Netlify.env.get("DYREP_GEO_NETLIFY_BATCH_ID");
	const requestHash = Netlify.env.get("DYREP_GEO_NETLIFY_REQUEST_HASH");
	if (
		!token ||
		token.length < 32 ||
		!batchId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId) ||
		!requestHash ||
		!/^sha256:[0-9a-f]{64}$/.test(requestHash)
	)
		return null;
	return { token, batchId, requestHash };
}

function response(body: unknown, status: number) {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(error: unknown) {
	const code = error instanceof Error ? error.message : "";
	const statuses: Record<string, number> = {
		idempotency_conflict: 409,
		batch_not_found: 404,
		body_too_large: 413,
		invalid_body: 400,
		request_binding_mismatch: 400,
		invalid_pagination: 400,
		invalid_idempotency_key: 400,
	};
	return Object.hasOwn(statuses, code)
		? response({ error: code }, statuses[code])
		: response({ error: "request_failed", reason: netlifyFailureReason(error) }, 503);
}

export default async (request: Request, context: { site: { id: string } }) => {
	if (
		context.site.id !== "1ac9542d-dc7c-4c22-be2c-0ad5d495fcd9" ||
		Netlify.env.get("DYREP_GEO_TARGET_REF") !== "dyrep-org"
	) {
		return response({ error: "unavailable" }, 503);
	}
	const binding = bindingSettings();
	if (!binding) return response({ error: "unavailable" }, 503);
	const { token, batchId, requestHash } = binding;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))) {
		return response({ error: "unauthorized" }, 401);
	}
	const url = new URL(request.url);
	try {
		if (request.method === "POST" && url.pathname === `/api/v1/cell-batches/${batchId}/advance`) {
			if (Netlify.env.get("DYREP_GEO_NETLIFY_EXECUTION_ENABLED") !== "true") {
				return response({ error: "execution_disabled" }, 409);
			}
			const workerToken = Netlify.env.get("DYREP_GEO_NETLIFY_WORKER_TOKEN");
			if (!workerToken || workerToken.length < 32) return response({ error: "unavailable" }, 503);
			const dispatched = await fetch("https://geo-pilot-dyrep-org.netlify.app/internal/geo/cell-batch", {
				method: "POST",
				headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
				body: JSON.stringify({ batchId }),
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			});
			return dispatched.status === 202
				? response({ batchId, status: "accepted", completionProven: false }, 202)
				: response({ error: "dispatch_failed" }, 503);
		}
		if (request.method === "POST" && url.pathname === "/api/v1/cell-batches") {
			const body = await readBody(request);
			const { parseScrapeTargets } = await import("@workspace/config/scrape-targets");
			const configs = parseScrapeTargets(Netlify.env.get("SCRAPE_TARGETS"));
			const { createNetlifyBatch } = await import("../../src/netlify-cell-api.js");
			const result = await createNetlifyBatch(
				body,
				request.headers.get("idempotency-key") ?? "",
				{ batchId, requestHash },
				configs,
			);
			// Persisting the plan is separate from the explicitly enabled worker invocation.
			return response(result, result.idempotentReplay ? 200 : 201);
		}
		if (request.method === "GET" && url.pathname === `/api/v1/cell-batches/${batchId}/cells`) {
			const { readNetlifyBatch } = await import("../../src/netlify-cell-api.js");
			return response(
				await readNetlifyBatch(
					{ batchId, requestHash },
					Number(url.searchParams.get("page") ?? 1),
					Number(url.searchParams.get("limit") ?? 100),
				),
				200,
			);
		}
		if (request.method === "GET" && url.pathname === `/api/v1/cell-batches/${batchId}/provider-progress`) {
			const { readNetlifyBatch } = await import("../../src/netlify-cell-api.js");
			await readNetlifyBatch({ batchId, requestHash }, 1, 1);
			const { db } = await import("@workspace/lib/db/db");
			const { rows } = await db.$client.query(
				"SELECT surface,status,provider_id,poll_attempts,next_poll_at,error_code,updated_at FROM public.dyrep_provider_submissions WHERE batch_id=$1 ORDER BY surface",
				[batchId],
			);
			return response({ batchId, submissions: rows }, 200);
		}
		return response({ error: "not_found" }, 404);
	} catch (error) {
		return errorResponse(error);
	}
};

export const config = { path: ["/api/v1/cell-batches", "/api/v1/cell-batches/*"] };
