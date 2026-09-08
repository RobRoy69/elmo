import path from "node:path";
import { createPerplexityDiagnosticClient } from "../src/olostep-batch-client.js";
import { collectPerplexityDiagnostic, submitPerplexityDiagnostic } from "../src/perplexity-diagnostic.js";

async function main() {
	const [action] = process.argv.slice(2);
	if (process.argv.length !== 3 || !["submit", "collect"].includes(action))
		throw new Error("submit_or_collect_required");
	// Operator must provision this private directory once; never accept a fresh
	// journal path on each invocation, which could conceal a repeat submission.
	const directory = process.env.DYREP_DIAGNOSTIC_EVIDENCE_DIR;
	if (!directory || !path.isAbsolute(directory)) throw new Error("absolute_evidence_directory_required");
	const provider = createPerplexityDiagnosticClient(process.env.OLOSTEP_API_KEY ?? "");
	const result =
		action === "submit"
			? await submitPerplexityDiagnostic(directory, provider)
			: await collectPerplexityDiagnostic(directory, provider);
	console.log(JSON.stringify({ status: result.status, included_in_baseline: false }));
}
main().catch(() => {
	console.error("diagnostic_stopped_inspect_private_journal_no_resubmit");
	process.exitCode = 1;
});
