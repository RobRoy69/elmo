import assert from "node:assert/strict";
import { Pool } from "pg";
import { storageBootstrapSQL } from "./dyrep-storage-bootstrap.mjs";

const url = new URL(process.env.ELMO_WORKER_TEST_DATABASE_URL);
assert.equal(process.env.ELMO_WORKER_TEST_DISPOSABLE_DATABASE, "1");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.equal(url.pathname, "/elmo_test");
const pool = new Pool({ connectionString: url.toString() });
const client = await pool.connect();
try {
	await client.query("begin");
	await client.query(`create schema geo_pilot;
    create table geo_pilot.pilot_cell(target_ref text, project_ref text, branch_name text, transport_enabled boolean, provider_enabled boolean);
    insert into geo_pilot.pilot_cell values ('dyrep-org','dgrrwlamisfgtlwuhpqu','geo-pilot-dyrep-org',true,false);
    create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
	await client.query("savepoint wrong_target; update geo_pilot.pilot_cell set target_ref='other'");
	await assert.rejects(client.query(storageBootstrapSQL()), /dyrep_preview_binding_required/);
	await client.query("rollback to savepoint wrong_target");
	await client.query(storageBootstrapSQL());
	const result = await client.query(`select relname,relrowsecurity from pg_class where oid in
    ('public.cell_batches'::regclass,'public.cell_batch_cells'::regclass)`);
	assert.equal(result.rows.length, 2);
	assert.ok(result.rows.every((row) => row.relrowsecurity));
	for (const actor of ["anon", "authenticated", "service_role"]) {
		for (const table of ["cell_batches", "cell_batch_cells"]) {
			for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
				const check = await client.query("select has_table_privilege($1,$2,$3) permitted", [
					actor,
					`public.${table}`,
					privilege,
				]);
				assert.equal(check.rows[0].permitted, false);
			}
		}
	}
	await client.query("rollback");
	assert.equal((await client.query("select to_regclass('public.cell_batches') as batches")).rows[0].batches, null);
	console.log("PASS minimal storage bootstrap: two RLS tables, 24 denied privilege checks, rollback leaves no tables");
} finally {
	await client.query("rollback");
	client.release();
	await pool.end();
}
