import assert from "node:assert/strict";

const settings = new Map();
globalThis.Netlify = { env: { get: (key) => settings.get(key) } };
const { default: handler } = await import("../dist-runtime/netlify/dyrep-cell-background.mjs");
const context = { site: { id: "1ac9542d-dc7c-4c22-be2c-0ad5d495fcd9" } };
const messages = [];
const originalLog = console.log;
console.log = (message) => messages.push(JSON.parse(message));
try {
	await handler(new Request("https://example.test/internal/geo/cell-batch", { method: "POST" }), context);
	settings.set("DYREP_GEO_NETLIFY_EXECUTION_ENABLED", "true");
	settings.set("DYREP_GEO_TARGET_REF", "dyrep-org");
	settings.set("DYREP_GEO_NETLIFY_WORKER_TOKEN", "fixture-token-only-".repeat(3));
	settings.set("DYREP_GEO_NETLIFY_BATCH_ID", "22222222-2222-4222-8222-222222222222");
	settings.set("DYREP_GEO_NETLIFY_REQUEST_HASH", `sha256:${"a".repeat(64)}`);
	await handler(new Request("https://example.test/internal/geo/cell-batch", { method: "POST" }), context);
	assert.deepEqual(
		messages.map(({ status }) => status),
		["disabled", "unauthorized"],
	);
} finally {
	console.log = originalLog;
}
console.log("PASS packaged worker refuses disabled and unauthorized execution without provider configuration");
