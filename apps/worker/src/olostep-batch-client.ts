import { createHash } from "node:crypto";
import { extractCitationsFromOlostep } from "@workspace/lib/text-extraction";

export interface ProviderRequest {
	parser: { id: string };
	country: "NL";
	items: { custom_id: string; url: string }[];
}
export interface ProviderOutcome {
	cellId: string;
	text: string | null;
	citations: ReturnType<typeof extractCitationsFromOlostep>;
	modelVersion: string;
	errorCode: string | null;
	raw: unknown;
}
export interface BatchProvider {
	submit(request: ProviderRequest): Promise<string>;
	collect(id: string, request: ProviderRequest): Promise<ProviderOutcome[] | null>;
}

const surfaces: Record<string, [string, string]> = {
	"chatgpt-search": ["chatgpt-results", "https://chatgpt.com/"],
	"google-ai": ["google-aimode-results", "https://www.google.com/aimode"],
	perplexity: ["perplexity-results", "https://www.perplexity.ai/"],
};

export function providerRequest(surface: string, cells: { id: string; query_text: string }[]): ProviderRequest {
	const spec = surfaces[surface];
	if (!spec || cells.length !== 4 || new Set(cells.map((cell) => cell.id)).size !== 4)
		throw new Error("provider_matrix_invalid");
	return {
		parser: { id: `@olostep/${spec[0]}` },
		country: "NL",
		items: cells.map((cell) => ({ custom_id: cell.id, url: `${spec[1]}?q=${encodeURIComponent(cell.query_text)}` })),
	};
}

export function providerRequestHash(request: ProviderRequest): string {
	// Reconstruct the wire order after a JSONB round trip.
	const body = {
		parser: { id: request.parser.id },
		country: request.country,
		items: request.items.map(({ custom_id, url }) => ({ custom_id, url })),
	};
	return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider_payload_invalid");
	return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new Error("provider_identifier_invalid");
	return value;
}

function boundItems(
	id: string,
	body: ProviderRequest,
	completed: Record<string, unknown>,
	failed: Record<string, unknown>,
) {
	const expected = new Map(body.items.map((item) => [item.custom_id, item.url]));
	const seen = new Set<string>();
	const result: { item: Record<string, unknown>; success: boolean }[] = [];
	for (const [listing, success] of [
		[completed, true],
		[failed, false],
	] as const) {
		if (
			listing.batch_id !== id ||
			!Array.isArray(listing.items) ||
			listing.cursor != null ||
			listing.next_cursor != null
		)
			throw new Error("provider_items_invalid");
		for (const raw of listing.items) {
			const item = record(raw);
			const cellId = identifier(item.custom_id);
			if (!expected.has(cellId) || seen.has(cellId) || item.url !== expected.get(cellId))
				throw new Error("provider_item_binding_mismatch");
			seen.add(cellId);
			result.push({ item, success });
		}
	}
	if (seen.size !== 4) throw new Error("provider_items_incomplete");
	return result;
}

function parseOutcome(payload: Record<string, unknown>, item: Record<string, unknown>): ProviderOutcome {
	const raw: unknown =
		typeof payload.json_content === "string" ? JSON.parse(payload.json_content) : payload.json_content;
	const parsed = record(raw);
	if (typeof parsed.prompt === "string" && parsed.prompt !== new URL(String(item.url)).searchParams.get("q"))
		throw new Error("provider_prompt_mismatch");
	const text =
		typeof parsed.answer_markdown === "string" && parsed.answer_markdown.trim() ? parsed.answer_markdown : null;
	return {
		cellId: identifier(item.custom_id),
		text,
		raw,
		citations: extractCitationsFromOlostep(parsed),
		modelVersion: typeof parsed.model === "string" ? parsed.model : "not_reported",
		errorCode: text ? null : "provider_answer_missing",
	};
}

export function createOlostepBatchClient(apiKey: string, fetcher: typeof fetch = fetch): BatchProvider {
	if (!apiKey.trim()) throw new Error("provider_credential_required");
	async function request(path: string, body?: ProviderRequest): Promise<Record<string, unknown>> {
		// Never retry a POST: a lost response does not prove that creation failed.
		const response = await fetcher(`https://api.olostep.com/v1/${path}`, {
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) throw new Error("provider_http_failed");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("provider_payload_invalid");
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 2_000_000) {
				await reader.cancel();
				throw new Error("provider_payload_too_large");
			}
			chunks.push(value);
		}
		return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	}
	return {
		async submit(body) {
			return identifier((await request("batches", body)).id);
		},
		async collect(id, body) {
			identifier(id);
			const info = await request(`batches/${id}`);
			if (info.id !== id || info.country !== body.country || info.parser !== body.parser.id || info.total_urls !== 4)
				throw new Error("provider_binding_mismatch");
			if (info.status !== "completed") {
				if (["pending", "running", "processing", "in_progress"].includes(String(info.status))) return null;
				throw new Error("provider_batch_not_completed");
			}
			const completed = await request(`batches/${id}/items?status=completed&limit=10`);
			const failed = await request(`batches/${id}/items?status=failed&limit=10`);
			const items = boundItems(id, body, completed, failed);
			const outcomes: ProviderOutcome[] = [];
			for (const { item, success } of items) {
				if (!success) {
					outcomes.push({
						cellId: identifier(item.custom_id),
						text: null,
						citations: [],
						modelVersion: "not_reported",
						errorCode: "provider_item_failed",
						raw: item,
					});
					continue;
				}
				const payload = await request(`retrieve?retrieve_id=${identifier(item.retrieve_id)}&formats=json`);
				outcomes.push(parseOutcome(payload, item));
			}
			return outcomes;
		},
	};
}
