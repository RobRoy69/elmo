import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { type BatchProvider, perplexityDiagnosticRequest, providerRequestHash } from "./olostep-batch-client.js";

async function record(file: string, value: unknown) {
	const handle = await open(file, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value, null, 2));
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export interface DiagnosticJournal {
	create(key: string, value: unknown): Promise<void>;
	read(key: string): Promise<string>;
}
function journal(source: string | DiagnosticJournal): DiagnosticJournal {
	return typeof source === "string"
		? {
				create: (key, value) => record(path.join(source, key), value),
				read: (key) => readFile(path.join(source, key), "utf8"),
			}
		: source;
}

// One fixed journal per worker evidence directory. Even a lost POST response
// leaves the exclusive intent file in place, so restart cannot submit again.
export async function submitPerplexityDiagnostic(directory: string | DiagnosticJournal, provider: BatchProvider) {
	const store = journal(directory);
	const request = perplexityDiagnosticRequest();
	const intent = {
		purpose: "diagnostic_only",
		included_in_baseline: false,
		request,
		requestHash: providerRequestHash(request),
		createdAt: new Date().toISOString(),
	};
	await store.create("perplexity-intent.json", intent);
	let id: string;
	try {
		id = await provider.submit(request);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid_provider_id");
	} catch {
		await store.create("perplexity-unknown.json", {
			status: "outcome_unknown",
			automatic_retry: false,
		});
		return { status: "outcome_unknown" };
	}
	await store.create("perplexity-submitted.json", { id, requestHash: intent.requestHash });
	return { status: "submitted", id };
}

export async function collectPerplexityDiagnostic(directory: string | DiagnosticJournal, provider: BatchProvider) {
	const store = journal(directory);
	const request = perplexityDiagnosticRequest();
	const intent = JSON.parse(await store.read("perplexity-intent.json"));
	const submitted = JSON.parse(await store.read("perplexity-submitted.json"));
	if (
		intent.requestHash !== providerRequestHash(request) ||
		providerRequestHash(intent.request) !== intent.requestHash ||
		submitted.requestHash !== intent.requestHash
	)
		throw new Error("diagnostic_evidence_mismatch");
	// A completed journal is immutable; repeated collection returns its receipt.
	try {
		const saved = JSON.parse(await store.read("perplexity-result.json"));
		if (
			saved.requestHash !== intent.requestHash ||
			saved.providerId !== submitted.id ||
			saved.outcomeSha256 !== createHash("sha256").update(JSON.stringify(saved.outcomes)).digest("hex")
		)
			throw new Error("diagnostic_result_evidence_mismatch");
		return saved;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const outcomes = await provider.collect(submitted.id, request);
	if (outcomes === null) return { status: "pending", providerId: submitted.id };
	if (outcomes.length !== 1 || outcomes[0].cellId !== request.items[0].custom_id)
		throw new Error("diagnostic_result_mismatch");
	const result = {
		status: outcomes[0].errorCode ? "failed" : "complete",
		providerId: submitted.id,
		requestHash: intent.requestHash,
		collectedAt: new Date().toISOString(),
		included_in_baseline: false,
		outcomes,
		outcomeSha256: createHash("sha256").update(JSON.stringify(outcomes)).digest("hex"),
	};
	await store.create("perplexity-result.json", result);
	return result;
}
