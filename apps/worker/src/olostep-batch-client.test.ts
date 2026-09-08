import { describe, expect, it, vi } from "vitest";
import { createOlostepBatchClient, providerRequest, providerRequestHash } from "./olostep-batch-client.js";

const body = providerRequest(
	"chatgpt-search",
	[1, 2, 3, 4].map((n) => ({ id: `cell-${n}`, query_text: `Vraag ${n}` })),
);
function transport(
	options: {
		duplicate?: boolean;
		missing?: boolean;
		wrongPrompt?: boolean;
		waiting?: boolean;
		liveId?: boolean;
		conflictingId?: boolean;
	} = {},
) {
	const envelope = {
		...(options.liveId ? { id: "batch-test" } : { batch_id: "batch-test" }),
		...(options.conflictingId ? { id: "other-batch" } : {}),
	};
	return vi.fn<typeof fetch>(async (url) => {
		const path = new URL(String(url)).pathname;

		if (path.endsWith("/items")) {
			const failed = String(url).includes("status=failed");
			const items = failed ? [] : body.items.map((item, index) => ({ ...item, retrieve_id: `ret-${index}` }));
			if (options.duplicate && !failed) items[1] = items[0];
			return Response.json({
				...envelope,
				items,
			});
		}
		if (path.endsWith("/retrieve")) {
			const index = Number(new URL(String(url)).searchParams.get("retrieve_id")!.split("-")[1]);
			return Response.json({
				json_content: JSON.stringify({
					prompt: options.wrongPrompt ? "Other question" : `Vraag ${index + 1}`,
					answer_markdown: options.missing ? " " : "DyReP answer",
					sources: [{ url: "https://uncited.example/", cited: false }],
				}),
			});
		}
		return Response.json({
			id: "batch-test",
			parser: body.parser.id,
			country: "NL",
			total_urls: 4,
			status: options.waiting ? "processing" : "completed",
		});
	});
}
describe("bounded Olostep batch transport", () => {
	it("submits once and never retries an uncertain POST", async () => {
		const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
		await expect(createOlostepBatchClient("test", send).submit(body)).rejects.toThrow();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
	});
	it("returns immediately while processing and uses only GET to collect", async () => {
		const send = transport({ waiting: true });
		expect(await createOlostepBatchClient("test", send).collect("batch-test", body)).toBeNull();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][1]?.method).toBe("GET");
	});
	it("binds four answers to their cells and excludes explicitly uncited sources", async () => {
		const send = transport();
		const outcomes = await createOlostepBatchClient("test", send).collect("batch-test", body);
		expect(outcomes).toHaveLength(4);
		expect(outcomes?.every((item) => item.text === "DyReP answer" && item.citations.length === 0)).toBe(true);
		expect(send.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
	});
	it.each([{ duplicate: true }, { wrongPrompt: true }])("rejects mismatched result evidence: %j", async (options) => {
		await expect(createOlostepBatchClient("test", transport(options)).collect("batch-test", body)).rejects.toThrow();
	});
	it("records missing answers as failures, not brand absence", async () => {
		const result = await createOlostepBatchClient("test", transport({ missing: true })).collect("batch-test", body);
		expect(result?.every((item) => item.errorCode === "provider_answer_missing" && item.text === null)).toBe(true);
	});
	it("collects the live API id envelope and rejects conflicting batch identifiers", async () => {
		expect(
			await createOlostepBatchClient("test", transport({ liveId: true })).collect("batch-test", body),
		).toHaveLength(4);
		await expect(
			createOlostepBatchClient("test", transport({ conflictingId: true })).collect("batch-test", body),
		).rejects.toThrow("provider_items_invalid");
	});
	it.each([false, true])("accepts equivalent space encoding but rejects extra query parameters: %s", async (extra) => {
		const original = transport({ liveId: true });
		const encoded: typeof fetch = async (url, init) => {
			const response = await original(url, init);
			if (!new URL(String(url)).pathname.endsWith("/items")) return response;
			const payload = (await response.json()) as { items: { url: string }[] };
			for (const item of payload.items) item.url = item.url.replaceAll("%20", "+") + (extra ? "&other=1" : "");
			return Response.json(payload);
		};
		const result = createOlostepBatchClient("test", encoded).collect("batch-test", body);
		if (extra) await expect(result).rejects.toThrow("provider_item_binding_mismatch");
		else expect(await result).toHaveLength(4);
	});
	it("rejects a provider ID containing a URL before network access", async () => {
		const send = transport();
		await expect(createOlostepBatchClient("test", send).collect("https://other.example", body)).rejects.toThrow();
		expect(send).not.toHaveBeenCalled();
	});
	it("keeps request binding through a JSONB key-order change", () => {
		expect(providerRequestHash({ items: body.items, country: "NL", parser: body.parser })).toBe(
			providerRequestHash(body),
		);
	});
});
