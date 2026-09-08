# One-item Perplexity diagnostic

Build candidate, 2026-09-08. Not deployed or submitted to Olostep.

This diagnostic uses the existing worker provider transport with one fixed Dutch question, NL and the Perplexity parser. The regular cell contract and four-item provider route are unchanged. Results are marked excluded from the baseline.

The operator entrypoint is `scripts/perplexity-diagnostic.ts`, run with the existing pnpm/tsx runtime and exactly one action: `submit` or `collect`. It reads `OLOSTEP_API_KEY` from the protected process environment and `DYREP_DIAGNOSTIC_EVIDENCE_DIR` from deployment configuration. It prints status only. Neither value should be supplied on a command line or committed.

Before execution, provision one private, persistent evidence directory and bind it to the worker identity. On Windows, set and check the directory ACL explicitly: POSIX mode 0600 does not establish Windows access control. Never use ephemeral Netlify function storage. The current Netlify deployment therefore cannot run this file unchanged; hosted durable storage integration is a separate deployment step. No database, RLS, Gateway policy or existing pilot activation was changed.

The exclusive, flushed intent file must exist before a POST is sent. Duplicate or concurrent submission against this journal fails before contacting the provider. A lost response creates an outcome-unknown record and must be reviewed; do not delete the journal, change its directory or replay automatically. If storing the returned provider ID fails, the intent still blocks resubmission. The guarantee is scoped to the configured persistent directory, not every possible installation.

`collect` makes one read-only pass. Pending state returns immediately. The operator may collect again; there is no automatic poll or submit loop. A terminal outcome is stored separately with request binding and payload hash. Repeated collection returns that result without a provider request. Hashes detect accidental drift, not malicious rewriting by an actor with directory write access.

Validation: 15 targeted tests pass, covering normal transport and one-item diagnostics, uncertain POST, concurrent/repeated submission and stored-result reuse. Worker typecheck passes. Changed files pass error-level Biome checking. Full repository lint reports 651 formatting errors; the first is an untouched CRLF file apps/cli/package.json. No broad formatting rewrite was performed. Full CI is not claimed.

Remaining before live proof: durable private deployment storage, protected credential handoff to the chosen runtime, deployment verification and one explicit submit/collect cycle. Local tests use fixtures and do not explain the four previous real provider failures.
