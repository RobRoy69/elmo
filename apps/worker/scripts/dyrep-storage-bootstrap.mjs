import { readFileSync } from "node:fs";

export function storageBootstrapSQL() {
	const migrations = new URL("../../../packages/lib/src/db/migrations/", import.meta.url);
	const initial = readFileSync(new URL("0000_hot_excalibur.sql", migrations), "utf8");
	const reportType = initial.split("\n").find((line) => line.startsWith('CREATE TYPE "public"."report_status"'));
	if (!reportType) throw new Error("report_status_source_missing");
	const cells = readFileSync(new URL("0018_dyrep_cell_batches.sql", migrations), "utf8");
	return `SET LOCAL search_path = public;
DO $guard$ BEGIN
  IF (SELECT count(*) FROM geo_pilot.pilot_cell WHERE target_ref='dyrep-org'
    AND project_ref='dgrrwlamisfgtlwuhpqu' AND branch_name='geo-pilot-dyrep-org'
    AND transport_enabled AND NOT provider_enabled) <> 1 THEN
    RAISE EXCEPTION 'dyrep_preview_binding_required';
  END IF;
END $guard$;
${reportType}
${cells}
REVOKE ALL ON public.cell_batches, public.cell_batch_cells FROM PUBLIC;
DO $privileges$ DECLARE actor text; BEGIN
  FOREACH actor IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=actor) THEN
      EXECUTE format('REVOKE ALL ON public.cell_batches, public.cell_batch_cells FROM %I', actor);
    END IF;
  END LOOP;
END $privileges$;
`;
}

if (process.argv.includes("--print")) process.stdout.write(storageBootstrapSQL());
