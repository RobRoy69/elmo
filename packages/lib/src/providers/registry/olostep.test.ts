import { beforeEach, describe, expect, it, vi } from "vitest";

const response = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock("../../secrets", () => ({ getCredential: () => "test-only" }));
vi.mock("olostep", () => ({
	default: class {
		batches = {
			create: async () => ({
				waitTillDone: async () => {},
				items: async function* () {
					yield { retrieve_id: "fixture" };
				},
			}),
		};
		retrieve = async () => ({ json_content: JSON.stringify(response.payload) });
	},
}));

import { extractCitationsFromOlostep } from "../../text-extraction";
import { olostep } from "./olostep";

beforeEach(() => {
	response.payload = { answer_markdown: "A measured answer." };
});

describe("Olostep observation integrity", () => {
	it("keeps inline citations and excludes explicitly uncited sources", async () => {
		response.payload = {
			answer_markdown: "An answer with a citation.",
			inline_references: [{ url: "https://dyrep.org/work/", text: "Work" }],
			sources: [
				{ url: "https://dyrep.org/work/", cited: true },
				{ url: "https://example.com/uncited", cited: false },
			],
		};
		const result = await olostep.run("chatgpt", "A question");
		expect(result.citations).toEqual([
			{ url: "https://dyrep.org/work/", title: "Work", domain: "dyrep.org", citationIndex: 0 },
		]);
		expect(result.rawOutput).toEqual(response.payload);
		expect(extractCitationsFromOlostep({ json_content: response.payload })).toEqual(result.citations);
	});

	it("does not let an empty source drawer hide inline references", () => {
		expect(
			extractCitationsFromOlostep({ sources: [], inline_references: [{ url: "https://dyrep.org/" }] }),
		).toHaveLength(1);
	});

	it.each([{}, { answer_markdown: "   " }, { answer: 42 }])(
		"rejects missing answer content instead of storing a successful absence: %j",
		async (payload) => {
			response.payload = payload;
			await expect(olostep.run("chatgpt", "A question")).rejects.toThrow("olostep_answer_missing");
		},
	);

	it("accepts an actual answer with zero citations", async () => {
		const result = await olostep.run("perplexity", "A question");
		expect(result.textContent).toBe("A measured answer.");
		expect(result.citations).toEqual([]);
	});
});
