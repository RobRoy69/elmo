# DyReP cell-batch supplement

Status: `NON_ACTIVE_CANDIDATE`

Basis: Elmo `v0.3.0`, commit `36f4f6ad7479f1cb90e774e98fdc2ac175ea46c9`.

This fork candidate adds the smallest server-side supplement needed to preserve
DyReP query × surface × repetition identity. Existing report, prompt, dashboard
and scheduling behavior is unchanged.

The supplement accepts exactly two queries, the ordered surfaces
`chatgpt-search`, `google-ai`, `perplexity`, and two repetitions. All twelve
cells are planned in the database before a provider call. A request is bound to
an `Idempotency-Key`, canonical request hash, and the deployment's fixed
`DYREP_GEO_TARGET_REF`.

Worker recovery is fail-closed: terminal cells are never repeated; pending
cells may run once; a cell left `running` by a dead worker becomes
`outcome_unknown_after_worker_restart` and is not sent to the provider again.
A replay of a pending batch repairs a crash between database commit and queue
send through a batch-bound pg-boss singleton key.

Endpoints:

- `POST /api/v1/cell-batches`
- `GET /api/v1/cell-batches/{batchId}/cells?page=1&limit=100`

This commit does not contain credentials, deployment configuration, image
publication, provider calls, production authority, or an activation decision.
