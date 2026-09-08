import type { PoolConfig } from "pg";
import { SUPABASE_PROD_CA_2021 } from "./supabase-prod-ca-2021";

export function netlifyPoolConfig(connectionString: string | undefined): PoolConfig {
	if (!connectionString) throw new Error("netlify_database_required");
	const url = new URL(connectionString);
	const direct = url.hostname === "db.phhirxlgiwopfqzyxakm.supabase.co" && url.username === "geo_elmo_netlify_dyrep_r1";
	const sessionPooler =
		url.hostname === "aws-1-eu-west-1.pooler.supabase.com" &&
		url.username === "geo_elmo_netlify_dyrep_r1.phhirxlgiwopfqzyxakm";
	if (
		url.protocol !== "postgresql:" ||
		(!direct && !sessionPooler) ||
		url.port !== "5432" ||
		url.pathname !== "/postgres" ||
		!url.password ||
		url.search !== "?sslmode=verify-full"
	)
		throw new Error("netlify_database_binding_invalid");
	url.search = "";
	return {
		connectionString: url.toString(),
		ssl: { ca: SUPABASE_PROD_CA_2021, rejectUnauthorized: true },
		max: 1,
		connectionTimeoutMillis: 5000,
		idleTimeoutMillis: 10000,
		statement_timeout: 12000,
		query_timeout: 15000,
	};
}
