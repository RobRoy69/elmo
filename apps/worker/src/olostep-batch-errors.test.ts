import { describe, expect, it } from "vitest";
import { collectionErrorCode } from "./olostep-batch-step.js";

describe("safe collection errors", () => {
	it("exposes a known bounded payload failure", () => {
		expect(collectionErrorCode(new Error("provider_payload_too_large"))).toBe("provider_payload_too_large");
	});
	it("never exposes arbitrary provider or credential-bearing messages", () => {
		expect(collectionErrorCode(new Error("Bearer private-value at upstream"))).toBe(
			"collection_requires_retry_or_review",
		);
		expect(collectionErrorCode({ message: "provider_payload_too_large" })).toBe("collection_requires_retry_or_review");
	});
});
