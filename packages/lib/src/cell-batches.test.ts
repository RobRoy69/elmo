import { describe, expect, it, vi } from "vitest";
import {
	canonicalizeCellBatchWebsite,
	DYREP_CELL_SURFACES,
	DYREP_CELL_TARGET_WEBSITES,
	executeCellBatchTargetBound,
	normalizeCellBatchRequest,
	planCellCoordinates,
	recoveryAction,
	resolveCellBatchIdempotency,
	resolveCellSurfaceConfigs,
	validateCellBatchTargetBinding,
} from "./cell-batches";

const request = {
	targetRef: "dyrep-org",
	brandName: "DyReP",
	brandWebsite: "https://dyrep.org",
	queries: [
		{ queryRef: "q1", text: "Een" },
		{ queryRef: "q2", text: "Twee" },
	],
	surfaces: [...DYREP_CELL_SURFACES],
	repetitions: 2,
};
const configs = [
	{ model: "chatgpt", provider: "olostep", webSearch: true },
	{ model: "google-ai-mode", provider: "dataforseo", webSearch: true },
	{ model: "perplexity", provider: "olostep", webSearch: true },
];

describe("DyReP cell-batchcontract", () => {
	it("plant exact 2×3×2 canoniek met providerprovenance", () => {
		const normalized = normalizeCellBatchRequest(request);
		const cells = planCellCoordinates(normalized.body, resolveCellSurfaceConfigs(configs));
		expect(cells).toHaveLength(12);
		expect(new Set(cells.map((cell) => `${cell.queryRef}:${cell.surface}:${cell.repetition}`)).size).toBe(12);
		expect(cells.map(({ queryRef, surface, repetition }) => [queryRef, surface, repetition])).toEqual(
			request.queries.flatMap(({ queryRef }) =>
				DYREP_CELL_SURFACES.flatMap((surface) => [1, 2].map((r) => [queryRef, surface, r])),
			),
		);
	});

	it("hash is stabiel en een dubbele queryref valt dicht", () => {
		expect(normalizeCellBatchRequest(request).requestHash).toBe(
			normalizeCellBatchRequest(structuredClone(request)).requestHash,
		);
		expect(() => normalizeCellBatchRequest({ ...request, queries: [request.queries[0], request.queries[0]] })).toThrow(
			"cell_batch_duplicate_query_ref",
		);
	});

	it("idempotency en crashherstel herhalen nooit een ambigue providercall", () => {
		const hash = normalizeCellBatchRequest(request).requestHash;
		expect(resolveCellBatchIdempotency(null, hash)).toBe("create");
		expect(resolveCellBatchIdempotency(hash, hash)).toBe("replay");
		expect(() => resolveCellBatchIdempotency(`sha256:${"0".repeat(64)}`, hash)).toThrow(
			"cell_batch_idempotency_conflict",
		);
		expect(recoveryAction("pending")).toBe("execute");
		expect(recoveryAction("running")).toBe("fail_outcome_unknown");
		expect(recoveryAction("complete")).toBe("keep_terminal");
		expect(recoveryAction("failed")).toBe("keep_terminal");
	});

	it("mist, dubbel of anders geordende surfaces vallen dicht", () => {
		expect(() =>
			normalizeCellBatchRequest({ ...request, surfaces: ["chatgpt-search", "perplexity", "google-ai"] }),
		).toThrow();
		expect(() => resolveCellSurfaceConfigs(configs.slice(0, 2))).toThrow(
			"cell_batch_surface_binding_invalid:perplexity",
		);
		expect(() => resolveCellSurfaceConfigs([...configs, configs[0]])).toThrow(
			"cell_batch_surface_binding_invalid:chatgpt-search",
		);
	});

	it("bindt ieder target uitsluitend aan zijn canonieke website", () => {
		for (const [targetRef, website] of Object.entries(DYREP_CELL_TARGET_WEBSITES)) {
			expect(validateCellBatchTargetBinding(targetRef, targetRef, website)).toBeNull();
			expect(canonicalizeCellBatchWebsite(targetRef as keyof typeof DYREP_CELL_TARGET_WEBSITES, `${website}/`)).toBe(
				website,
			);
			for (const [otherTarget, otherWebsite] of Object.entries(DYREP_CELL_TARGET_WEBSITES)) {
				if (otherTarget === targetRef) continue;
				expect(validateCellBatchTargetBinding(targetRef, targetRef, otherWebsite)).toBe("target_website_mismatch");
			}
		}
	});

	it("weigert ontbrekende, onbekende en cross-target deploymentbindingen", () => {
		expect(validateCellBatchTargetBinding(undefined, request.targetRef, request.brandWebsite)).toBe(
			"deployment_target_missing",
		);
		expect(validateCellBatchTargetBinding("unknown", request.targetRef, request.brandWebsite)).toBe(
			"deployment_target_invalid",
		);
		expect(validateCellBatchTargetBinding("rob-concepting-nl", request.targetRef, request.brandWebsite)).toBe(
			"target_mismatch",
		);
	});

	it("weigert websitevarianten buiten de canonieke origin", () => {
		for (const website of [
			"http://dyrep.org",
			"https://www.dyrep.org",
			"https://dyrep.org:444",
			"https://dyrep.org/path",
			"https://dyrep.org?query=1",
			"https://dyrep.org#fragment",
			"https://user:secret@dyrep.org",
			"not-a-url",
		]) {
			expect(validateCellBatchTargetBinding("dyrep-org", "dyrep-org", website)).toBe("target_website_mismatch");
		}
	});

	it("roept de provider nooit aan buiten de deploymentbinding", async () => {
		const providerCall = vi.fn(async () => "provider-result");
		const denied = await executeCellBatchTargetBound(
			"dyrep-org",
			"rob-concepting-nl",
			"https://rob-concepting.com",
			providerCall,
		);
		expect(denied).toEqual({ ok: false, bindingFailure: "target_mismatch" });
		expect(providerCall).not.toHaveBeenCalled();

		const allowed = await executeCellBatchTargetBound("dyrep-org", "dyrep-org", "https://dyrep.org", providerCall);
		expect(allowed).toEqual({ ok: true, value: "provider-result" });
		expect(providerCall).toHaveBeenCalledOnce();
	});
});
