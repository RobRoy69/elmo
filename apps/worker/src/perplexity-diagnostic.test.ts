import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
	type BatchProvider,
	createOlostepBatchClient,
	createPerplexityDiagnosticClient,
	perplexityDiagnosticRequest,
} from "./olostep-batch-client.js";
import { collectPerplexityDiagnostic, submitPerplexityDiagnostic } from "./perplexity-diagnostic.js";

it("rejects widened diagnostic requests and keeps the regular four-item limit", async () => {
	const fetcher = vi.fn<typeof fetch>();
	const request = perplexityDiagnosticRequest();
	await expect(createOlostepBatchClient("fixture", fetcher).submit(request)).rejects.toThrow("provider_matrix_invalid");
	request.items[0].url += "changed";
	await expect(createPerplexityDiagnosticClient("fixture", fetcher).submit(request)).rejects.toThrow(
		"diagnostic_request_mismatch",
	);
	expect(fetcher).not.toHaveBeenCalled();
});

it("collects one bound failed item without treating it as an answer", async () => {
	const request = perplexityDiagnosticRequest();
	const fetcher = vi.fn<typeof fetch>(async (url) => {
		if (String(url).includes("/items"))
			return Response.json({
				id: "batch-diagnostic",
				items: String(url).includes("status=failed") ? request.items : [],
			});
		return Response.json({
			id: "batch-diagnostic",
			country: "NL",
			parser: request.parser.id,
			total_urls: 1,
			status: "completed",
		});
	});
	const result = await createPerplexityDiagnosticClient("fixture", fetcher).collect("batch-diagnostic", request);
	expect(result).toHaveLength(1);
	expect(result?.[0]).toMatchObject({ text: null, errorCode: "provider_item_failed" });
	expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it("persists uncertain submission and blocks restart or concurrent resubmission", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "dyrep-diagnostic-test-"));
	const provider: BatchProvider = {
		submit: vi.fn(async () => {
			throw new Error("lost response");
		}),
		collect: vi.fn(),
	};
	try {
		const results = await Promise.allSettled([
			submitPerplexityDiagnostic(directory, provider),
			submitPerplexityDiagnostic(directory, provider),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(provider.submit).toHaveBeenCalledTimes(1);
		await expect(submitPerplexityDiagnostic(directory, provider)).rejects.toThrow();
		expect(JSON.parse(await readFile(path.join(directory, "perplexity-unknown.json"), "utf8")).status).toBe(
			"outcome_unknown",
		);
	} finally {
		await rm(directory, { recursive: true });
	}
});

it("stores result separately and returns it without new provider calls", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "dyrep-diagnostic-test-"));
	const provider: BatchProvider = {
		submit: vi.fn(async () => "batch-diagnostic"),
		collect: vi.fn(async () => [
			{
				cellId: perplexityDiagnosticRequest().items[0].custom_id,
				text: "Example answer",
				citations: [],
				modelVersion: "fixture",
				errorCode: null,
				raw: { fixture: true },
			},
		]),
	};
	try {
		await submitPerplexityDiagnostic(directory, provider);
		const result = await collectPerplexityDiagnostic(directory, provider);
		expect(result).toMatchObject({ status: "complete", included_in_baseline: false });
		expect(await collectPerplexityDiagnostic(directory, provider)).toEqual(result);
		expect(provider.submit).toHaveBeenCalledTimes(1);
		expect(provider.collect).toHaveBeenCalledTimes(1);
	} finally {
		await rm(directory, { recursive: true });
	}
});
