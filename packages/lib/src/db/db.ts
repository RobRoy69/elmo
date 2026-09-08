import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { netlifyPoolConfig } from "./netlify-pool";
import * as schema from "./schema";

export const db =
	process.env.DYREP_GEO_DATABASE_PROFILE === "netlify-dyrep"
		? drizzle(new Pool(netlifyPoolConfig(process.env.DYREP_GEO_ELMO_DATABASE_URL)), { schema })
		: drizzle(process.env.DATABASE_URL!, { schema });
