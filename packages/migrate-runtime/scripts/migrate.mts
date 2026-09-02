import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exitCode = 1;
} else {
	const pool = new Pool({ connectionString: databaseUrl });
	const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

	try {
		await migrate(drizzle(pool), { migrationsFolder });
	} finally {
		await pool.end();
	}
}
