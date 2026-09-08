import type { DiagnosticJournal } from "./perplexity-diagnostic.js";

interface BlobStore {
	set(key: string, value: string, options: { onlyIfNew: true }): Promise<{ modified: boolean }>;
	get(key: string): Promise<string | null>;
}
export function diagnosticBlobs(store: BlobStore): DiagnosticJournal {
	return {
		async create(key, value) {
			const result = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
			if (!result.modified) throw new Error("diagnostic_already_recorded");
		},
		async read(key) {
			const value = await store.get(key);
			if (value === null) throw Object.assign(new Error("missing_evidence"), { code: "ENOENT" });
			return value;
		},
	};
}
