import { expect, it, vi } from "vitest";
import { diagnosticBlobs } from "./diagnostic-blobs.js";
import { submitPerplexityDiagnostic } from "./perplexity-diagnostic.js";

it("does not submit when persistent conditional creation loses the race", async () => {
	const store = { set: vi.fn(async () => ({ modified: false })), get: vi.fn(async () => null) };
	const provider = { submit: vi.fn(), collect: vi.fn() };
	await expect(submitPerplexityDiagnostic(diagnosticBlobs(store), provider)).rejects.toThrow(
		"diagnostic_already_recorded",
	);
	expect(provider.submit).not.toHaveBeenCalled();
	expect(store.set.mock.calls[0]).toEqual(["perplexity-intent.json", expect.any(String), { onlyIfNew: true }]);
});

it("does not submit after a storage failure and distinguishes absent evidence", async () => {
	const store = {
		set: vi.fn(async () => {
			throw new Error("storage unavailable");
		}),
		get: vi.fn(async () => null),
	};
	const provider = { submit: vi.fn(), collect: vi.fn() };
	await expect(submitPerplexityDiagnostic(diagnosticBlobs(store), provider)).rejects.toThrow("storage unavailable");
	expect(provider.submit).not.toHaveBeenCalled();
	await expect(diagnosticBlobs(store).read("missing")).rejects.toMatchObject({ code: "ENOENT" });
});
