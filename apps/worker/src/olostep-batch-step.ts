import { normalizeCellBatchRequest } from "@workspace/lib/cell-batches";
import type { Pool, PoolClient } from "pg";
import type { BatchBinding } from "./netlify-cell-api.js";
import {
	type BatchProvider,
	type ProviderOutcome,
	type ProviderRequest,
	providerRequest,
	providerRequestHash,
} from "./olostep-batch-client.js";

interface Submission {
	batch_id: string;
	surface: string;
	request_body: ProviderRequest;
	request_hash: string;
	status: string;
	provider_id: string | null;
}
interface Cell {
	id: string;
	query_ref: string;
	query_text: string;
	surface: string;
	repetition: number;
	provider: string;
	model: string;
	probe_modality: string;
	status: string;
}
const models: Record<string, string> = {
	"chatgpt-search": "chatgpt",
	"google-ai": "google-ai-mode",
	perplexity: "perplexity",
};

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await run(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

function validateCells(cells: Cell[], body: ReturnType<typeof normalizeCellBatchRequest>["body"]) {
	if (cells.length !== 12) throw new Error("provider_matrix_invalid");
	for (const query of body.queries) {
		for (const surface of body.surfaces) {
			for (const repetition of [1, 2]) {
				const matches = cells.filter(
					(cell) => cell.query_ref === query.queryRef && cell.surface === surface && cell.repetition === repetition,
				);
				if (
					matches.length !== 1 ||
					matches[0].query_text !== query.text ||
					matches[0].provider !== "olostep" ||
					matches[0].model !== models[surface] ||
					matches[0].probe_modality !== "consumer"
				)
					throw new Error("provider_matrix_invalid");
			}
		}
	}
}

async function persistPlans(client: PoolClient, binding: BatchBinding, cells: Cell[], existing: Submission[]) {
	for (const surface of Object.keys(models)) {
		const body = providerRequest(
			surface,
			cells.filter((cell) => cell.surface === surface),
		);
		const hash = providerRequestHash(body);
		if (existing.length) {
			const row = existing.find((item) => item.surface === surface);
			if (!row || row.request_hash !== hash || providerRequestHash(row.request_body) !== hash)
				throw new Error("provider_plan_drift");
		} else {
			await client.query(
				"INSERT INTO public.dyrep_provider_submissions(batch_id,surface,request_body,request_hash) VALUES($1,$2,$3,$4)",
				[binding.batchId, surface, body, hash],
			);
		}
	}
}

async function prepare(pool: Pool, binding: BatchBinding): Promise<boolean> {
	return transaction(pool, async (client) => {
		const {
			rows: [batch],
		} = await client.query("SELECT * FROM public.cell_batches WHERE id=$1 FOR UPDATE", [binding.batchId]);
		if (
			!batch ||
			batch.target_ref !== "dyrep-org" ||
			batch.brand_website !== "https://dyrep.org" ||
			batch.request_hash !== binding.requestHash
		)
			throw new Error("request_binding_mismatch");
		const normalized = normalizeCellBatchRequest(batch.request_body);
		if (normalized.requestHash !== binding.requestHash) throw new Error("request_binding_mismatch");
		if (["completed", "failed"].includes(batch.status)) return false;
		const { rows: cells } = await client.query<Cell>(
			"SELECT * FROM public.cell_batch_cells WHERE batch_id=$1 ORDER BY query_ordinal,surface_ordinal,repetition",
			[binding.batchId],
		);
		validateCells(cells, normalized.body);
		const { rows: existing } = await client.query<Submission>(
			"SELECT * FROM public.dyrep_provider_submissions WHERE batch_id=$1",
			[binding.batchId],
		);
		if (existing.length !== 0 && existing.length !== 3) throw new Error("provider_plan_incomplete");
		if (!existing.length && (batch.status !== "pending" || cells.some((cell) => cell.status !== "pending")))
			throw new Error("provider_plan_not_pending");
		await persistPlans(client, binding, cells, existing);
		await client.query("UPDATE public.cell_batches SET status='processing',updated_at=now() WHERE id=$1", [
			binding.batchId,
		]);
		return true;
	});
}

async function finish(pool: Pool, row: Submission, outcomes: ProviderOutcome[]): Promise<void> {
	const expected = new Set(row.request_body.items.map((item) => item.custom_id));
	if (
		outcomes.length !== 4 ||
		new Set(outcomes.map((outcome) => outcome.cellId)).size !== 4 ||
		outcomes.some((outcome) => !expected.has(outcome.cellId) || (!outcome.errorCode && !outcome.text?.trim()))
	)
		throw new Error("provider_outcomes_invalid");
	await transaction(pool, async (client) => {
		// Serialize finalization across platforms before deciding the batch status.
		await client.query("SELECT id FROM public.cell_batches WHERE id=$1 FOR UPDATE", [row.batch_id]);
		const {
			rows: [current],
		} = await client.query<Submission>(
			"SELECT * FROM public.dyrep_provider_submissions WHERE batch_id=$1 AND surface=$2 FOR UPDATE",
			[row.batch_id, row.surface],
		);
		if (current?.status !== "submitted" || current.provider_id !== row.provider_id) return;
		for (const outcome of outcomes) {
			const result = await client.query(
				`UPDATE public.cell_batch_cells SET status=$1,text=$2,citations=$3,
				brand_mentioned=$4,citations_supported=$5,model_version=$6,error_code=$7,observed_at=now(),updated_at=now()
				WHERE id=$8 AND batch_id=$9 AND surface=$10 AND status='pending'`,
				[
					outcome.errorCode ? "failed" : "complete",
					outcome.text,
					JSON.stringify(outcome.citations),
					outcome.errorCode ? null : outcome.text!.toLowerCase().includes("dyrep"),
					!outcome.errorCode,
					outcome.modelVersion,
					outcome.errorCode,
					outcome.cellId,
					row.batch_id,
					row.surface,
				],
			);
			if (result.rowCount !== 1) throw new Error("provider_cell_state_conflict");
		}
		await client.query(
			`UPDATE public.dyrep_provider_submissions SET status=$1,results=$2,error_code=NULL,updated_at=now()
			WHERE batch_id=$3 AND surface=$4`,
			[
				outcomes.some((outcome) => outcome.errorCode) ? "failed" : "complete",
				JSON.stringify(outcomes),
				row.batch_id,
				row.surface,
			],
		);
		await client.query(
			`UPDATE public.cell_batches SET status=CASE WHEN EXISTS (
			SELECT 1 FROM public.cell_batch_cells WHERE batch_id=$1 AND status='failed') THEN 'failed'::report_status ELSE 'completed'::report_status END,
			completed_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND
			(SELECT count(*) FROM public.cell_batch_cells WHERE batch_id=$1 AND status IN ('complete','failed'))=12`,
			[row.batch_id],
		);
	});
}

/** One durable step per invocation; no waiting loop and no automatic submission retry. */
export async function runOlostepBatchStep(pool: Pool, binding: BatchBinding, provider: BatchProvider): Promise<string> {
	if (!(await prepare(pool, binding))) return "terminal";
	const {
		rows: [claimed],
	} = await pool.query<Submission>(
		`UPDATE public.dyrep_provider_submissions SET status='submitting',updated_at=now()
		WHERE (batch_id,surface)=(SELECT batch_id,surface FROM public.dyrep_provider_submissions
		WHERE batch_id=$1 AND status='pending' ORDER BY surface LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
		[binding.batchId],
	);
	if (claimed) {
		try {
			const id = await provider.submit(claimed.request_body);
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("provider_identifier_invalid");
			await pool.query(
				`UPDATE public.dyrep_provider_submissions SET status='submitted',provider_id=$1,
				submitted_at=now(),next_poll_at=now()+interval '30 seconds',updated_at=now()
				WHERE batch_id=$2 AND surface=$3 AND status='submitting'`,
				[id, claimed.batch_id, claimed.surface],
			);
			return "submitted";
		} catch {
			await pool.query(
				`UPDATE public.dyrep_provider_submissions SET status='outcome_unknown',error_code='submission_outcome_unknown',updated_at=now()
				WHERE batch_id=$1 AND surface=$2 AND status='submitting'`,
				[claimed.batch_id, claimed.surface],
			);
			return "outcome_unknown";
		}
	}
	// An interrupted invocation may have sent the POST. Never reclaim it for submission.
	await pool.query(
		`UPDATE public.dyrep_provider_submissions SET status='outcome_unknown',error_code='submission_outcome_unknown',updated_at=now()
		WHERE batch_id=$1 AND status='submitting' AND updated_at < now()-interval '5 minutes'`,
		[binding.batchId],
	);
	const {
		rows: [poll],
	} = await pool.query<Submission>(
		`UPDATE public.dyrep_provider_submissions SET
		poll_attempts=poll_attempts+1,next_poll_at=now()+interval '3 minutes',updated_at=now()
		WHERE (batch_id,surface)=(SELECT batch_id,surface FROM public.dyrep_provider_submissions
		WHERE batch_id=$1 AND status='submitted' AND poll_attempts<60 AND next_poll_at<=now()
		ORDER BY next_poll_at,surface LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
		[binding.batchId],
	);
	if (!poll) return "waiting_or_reconciliation_required";
	try {
		const outcomes = await provider.collect(poll.provider_id!, poll.request_body);
		if (outcomes === null) return "waiting";
		await finish(pool, poll, outcomes);
		return "collected";
	} catch {
		await pool.query(
			`UPDATE public.dyrep_provider_submissions SET error_code='collection_requires_retry_or_review',updated_at=now()
			WHERE batch_id=$1 AND surface=$2 AND status='submitted'`,
			[poll.batch_id, poll.surface],
		);
		return "collection_requires_retry_or_review";
	}
}
