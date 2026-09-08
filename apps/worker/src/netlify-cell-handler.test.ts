import { expect, it, vi } from "vitest";
import { handleNetlifyCellBatch } from "./netlify-cell-handler.js";

const settings = {
	enabled: "true",
	token: "test-only-token-".repeat(3),
	target: "dyrep-org",
	batchId: "22222222-2222-4222-8222-222222222222",
	requestHash: `sha256:${"a".repeat(64)}`,
};
const request = (body: unknown = { batchId: settings.batchId }, token = settings.token) =>
	new Request("https://example.test/internal/geo/cell-batch", {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});

it("executes only the configured authorized batch", async () => {
	const execute = vi.fn().mockResolvedValue("processed");
	expect(await handleNetlifyCellBatch(request(), settings, execute)).toBe("processed");
	expect(execute).toHaveBeenCalledExactlyOnceWith(settings.batchId, settings.requestHash);
});

it("rejects missing authority and request drift without loading the executor", async () => {
	const execute = vi.fn();
	for (const [req, config] of [
		[request(), { ...settings, enabled: "false" }],
		[request(), { ...settings, target: "other" }],
		[request(), { ...settings, token: "short" }],
		[request(), { ...settings, requestHash: "invalid" }],
		[request(undefined, "wrong"), settings],
		[request({ batchId: "other" }), settings],
		[request({ batchId: settings.batchId, prompt: "injected" }), settings],
		[request("x".repeat(2048)), settings],
	] as const) {
		expect(await handleNetlifyCellBatch(req, config, execute)).not.toBe("processed");
	}
	expect(execute).not.toHaveBeenCalled();
});
