import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeCellBatchRequest, planCellCoordinates, resolveCellSurfaceConfigs } from "@workspace/lib/cell-batches";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "./olostep-batch-client.js";
import { runOlostepBatchStep } from "./olostep-batch-step.js";

const source = process.env.ELMO_WORKER_TEST_DATABASE_URL;
if (process.env.ELMO_WORKER_TEST_REQUIRED === "1" && !source) throw new Error("disposable_database_required");
if (source) {
	const url = new URL(source);
	if (
		process.env.ELMO_WORKER_TEST_DISPOSABLE_DATABASE !== "1" ||
		!["localhost", "127.0.0.1"].includes(url.hostname) ||
		url.username !== "postgres" ||
		url.pathname !== "/elmo_test"
	)
		throw new Error("disposable_database_required");
}
const normalized = normalizeCellBatchRequest({
	targetRef: "dyrep-org",
	brandName: "DyReP",
	brandWebsite: "https://dyrep.org",
	queries: [
		{
			queryRef: "dyrep-work-source-origin",
			text: "Hoe kunnen we AI gebruiken zonder dat interne expertise losraakt van de oorspronkelijke bronnen?",
		},
		{
			queryRef: "dyrep-work-certainty",
			text: "Hoe voorkom ik dat een AI-antwoord stelliger is dan de deskundige die de informatie aanleverde?",
		},
	],
	surfaces: ["chatgpt-search", "google-ai", "perplexity"],
	repetitions: 2,
});
const binding = { batchId: "848fcc02-9788-445f-a117-ee962de94260", requestHash: normalized.requestHash };
const configs = ["chatgpt", "google-ai-mode", "perplexity"].map((model) => ({
	model,
	provider: "olostep",
	webSearch: true,
}));

(source ? describe : describe.skip)("durable provider lifecycle on isolated PostgreSQL", () => {
	let admin: Pool;
	let pool: Pool;
	let runtime: Pool;
	const database = `elmo_async_${randomUUID().replaceAll("-", "")}`;
	const submit = vi.fn(async (body: ProviderRequest) => body.parser.id.replaceAll(/[^a-z-]/g, ""));
	const collect = vi.fn(async (_id: string, body: ProviderRequest) =>
		body.items.map((item) => ({
			cellId: item.custom_id,
			text: "DyReP answer",
			citations: [],
			modelVersion: "not_reported",
			errorCode: null as string | null,
			raw: { answer_markdown: "DyReP answer" },
		})),
	);
	const provider = { submit, collect };
	beforeAll(async () => {
		admin = new Pool({ connectionString: source });
		await admin.query(`CREATE DATABASE ${database}`);
		const url = new URL(source!);
		url.pathname = `/${database}`;
		pool = new Pool({ connectionString: url.toString() });
		await pool.query("CREATE TYPE report_status AS ENUM ('pending','processing','completed','failed')");
		await pool.query(readFileSync(resolve("../../packages/lib/src/db/migrations/0018_dyrep_cell_batches.sql"), "utf8"));
		for (const role of ["anon", "authenticated", "service_role", "geo_elmo_netlify_dyrep_r1"]) {
			await pool.query(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`,
			);
		}
		await pool.query(`GRANT USAGE ON SCHEMA public TO geo_elmo_netlify_dyrep_r1;
			GRANT SELECT,INSERT ON cell_batches,cell_batch_cells TO geo_elmo_netlify_dyrep_r1;
			GRANT UPDATE(status,completed_at,updated_at) ON cell_batches TO geo_elmo_netlify_dyrep_r1;
			GRANT UPDATE(status,model_version,text,brand_mentioned,citations_supported,citations,observed_at,error_code,updated_at) ON cell_batch_cells TO geo_elmo_netlify_dyrep_r1;
			CREATE POLICY batch_runtime ON cell_batches TO geo_elmo_netlify_dyrep_r1 USING (target_ref='dyrep-org' AND request_hash='${binding.requestHash}') WITH CHECK (target_ref='dyrep-org' AND request_hash='${binding.requestHash}');
			CREATE POLICY cells_runtime ON cell_batch_cells TO geo_elmo_netlify_dyrep_r1 USING (EXISTS(SELECT 1 FROM cell_batches b WHERE b.id=batch_id));`);
		await pool.query(readFileSync(resolve("scripts/dyrep-provider-submissions.sql"), "utf8"));
		runtime = new Pool({ connectionString: url.toString(), options: "-c role=geo_elmo_netlify_dyrep_r1" });
	});
	beforeEach(async () => {
		submit.mockClear();
		collect.mockClear();
		await pool.query("TRUNCATE cell_batches CASCADE");
		await pool.query(
			"INSERT INTO cell_batches(id,target_ref,brand_name,brand_website,idempotency_key,request_hash,request_body) VALUES($1,'dyrep-org','DyReP','https://dyrep.org','test-once',$2,$3)",
			[binding.batchId, binding.requestHash, normalized.body],
		);
		for (const cell of planCellCoordinates(normalized.body, resolveCellSurfaceConfigs(configs))) {
			await pool.query(
				`INSERT INTO cell_batch_cells(batch_id,query_ref,query_text,query_ordinal,surface,surface_ordinal,repetition,provider,model)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				[
					binding.batchId,
					cell.queryRef,
					cell.queryText,
					cell.queryOrdinal,
					cell.surface,
					cell.surfaceOrdinal,
					cell.repetition,
					cell.provider,
					cell.model,
				],
			);
		}
	});
	afterAll(async () => {
		await runtime?.end();
		await pool?.end();
		if (admin) {
			await admin.query(`DROP DATABASE ${database}`);
			await admin.end();
		}
	});
	async function submitAll() {
		for (let n = 0; n < 3; n++) await runOlostepBatchStep(runtime, binding, provider);
	}
	async function due() {
		await pool.query(
			"UPDATE dyrep_provider_submissions SET next_poll_at=now()-interval '1 minute' WHERE status='submitted'",
		);
	}
	it("concurrent activation creates only three paid submissions", async () => {
		await Promise.all(Array.from({ length: 8 }, () => runOlostepBatchStep(runtime, binding, provider)));
		expect(submit).toHaveBeenCalledTimes(3);
		expect(
			(await pool.query("SELECT count(*)::int count FROM dyrep_provider_submissions WHERE status='submitted'")).rows[0]
				.count,
		).toBe(3);
	});
	it("collects all twelve cells and keeps terminal replay free of provider calls", async () => {
		await submitAll();
		for (let n = 0; n < 3; n++) {
			await due();
			expect(await runOlostepBatchStep(runtime, binding, provider)).toBe("collected");
		}
		expect((await pool.query("SELECT status FROM cell_batches")).rows[0].status).toBe("completed");
		expect(
			(await pool.query("SELECT count(*)::int count FROM cell_batch_cells WHERE status='complete'")).rows[0].count,
		).toBe(12);
		expect(await runOlostepBatchStep(runtime, binding, provider)).toBe("terminal");
		expect(submit).toHaveBeenCalledTimes(3);
		expect(collect).toHaveBeenCalledTimes(3);
	});
	it("keeps a partial provider failure visible instead of marking the batch complete", async () => {
		await submitAll();
		collect.mockImplementationOnce(async (_id, body) =>
			body.items.map((item, index) => ({
				cellId: item.custom_id,
				text: index === 0 ? "" : "DyReP answer",
				citations: [],
				modelVersion: "not_reported",
				errorCode: index === 0 ? "provider_answer_missing" : null,
				raw: {},
			})),
		);
		for (let n = 0; n < 3; n++) {
			await due();
			await runOlostepBatchStep(runtime, binding, provider);
		}
		expect((await pool.query("SELECT status FROM cell_batches")).rows[0].status).toBe("failed");
		expect(
			(await pool.query("SELECT count(*)::int count FROM cell_batch_cells WHERE status='complete'")).rows[0].count,
		).toBe(11);
		expect(
			(await pool.query("SELECT brand_mentioned FROM cell_batch_cells WHERE status='failed'")).rows[0].brand_mentioned,
		).toBeNull();
	});

	it("does not re-send a POST whose outcome is unknown", async () => {
		submit.mockRejectedValueOnce(new Error("lost response"));
		expect(await runOlostepBatchStep(runtime, binding, provider)).toBe("outcome_unknown");
		await submitAll();
		expect(submit).toHaveBeenCalledTimes(3);
		expect(
			(await pool.query("SELECT count(*)::int count FROM dyrep_provider_submissions WHERE status='outcome_unknown'"))
				.rows[0].count,
		).toBe(1);
	});
	it("marks an interrupted submission unknown without reclaiming it", async () => {
		await submitAll();
		await pool.query(
			"UPDATE dyrep_provider_submissions SET status='submitting',provider_id=NULL,updated_at=now()-interval '10 minutes' WHERE surface='google-ai'",
		);
		await runOlostepBatchStep(runtime, binding, provider);
		expect(submit).toHaveBeenCalledTimes(3);
		expect(
			(await pool.query("SELECT status FROM dyrep_provider_submissions WHERE surface='google-ai'")).rows[0].status,
		).toBe("outcome_unknown");
	});
	it("rejects a wrong request binding before any submission", async () => {
		await expect(
			runOlostepBatchStep(runtime, { ...binding, requestHash: `sha256:${"a".repeat(64)}` }, provider),
		).rejects.toThrow("request_binding_mismatch");
		expect(submit).not.toHaveBeenCalled();
	});
	it("rejects changed question text before any submission", async () => {
		await pool.query("UPDATE cell_batch_cells SET query_text='Other question'");
		await expect(runOlostepBatchStep(runtime, binding, provider)).rejects.toThrow("provider_matrix_invalid");
		expect(submit).not.toHaveBeenCalled();
	});
	it("preserves cells when retrieval fails and retries only collection", async () => {
		await submitAll();
		await due();
		collect.mockRejectedValueOnce(new Error("read timeout"));
		expect(await runOlostepBatchStep(runtime, binding, provider)).toBe("collection_requires_retry_or_review");
		expect(
			(await pool.query("SELECT count(*)::int count FROM cell_batch_cells WHERE status='pending'")).rows[0].count,
		).toBe(12);
		await due();
		await runOlostepBatchStep(runtime, binding, provider);
		expect(submit).toHaveBeenCalledTimes(3);
	});
	it("caps collection attempts without re-submitting", async () => {
		await submitAll();
		await pool.query("UPDATE dyrep_provider_submissions SET poll_attempts=60,next_poll_at=now()");
		expect(await runOlostepBatchStep(runtime, binding, provider)).toBe("waiting_or_reconciliation_required");
		expect(collect).not.toHaveBeenCalled();
		expect(submit).toHaveBeenCalledTimes(3);
	});
	it("denies runtime changes to bindings and denies public reads", async () => {
		await submitAll();
		await expect(runtime.query("UPDATE dyrep_provider_submissions SET request_hash='bad'")).rejects.toThrow();
		await expect(runtime.query("DELETE FROM dyrep_provider_submissions")).rejects.toThrow();
		for (const role of ["anon", "authenticated", "service_role"]) {
			expect(
				(await pool.query("SELECT has_table_privilege($1,'dyrep_provider_submissions','SELECT') allowed", [role]))
					.rows[0].allowed,
			).toBe(false);
		}
	});
});
