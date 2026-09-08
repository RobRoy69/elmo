import { describe, expect, it } from "vitest";
import { netlifyPoolConfig } from "../../../packages/lib/src/db/netlify-pool";

const connection =
	"postgresql://geo_elmo_netlify_dyrep_r1:test-only@db.phhirxlgiwopfqzyxakm.supabase.co:5432/postgres?sslmode=verify-full";

describe("Netlify database isolation", () => {
	it("requires verified TLS and limits connections", () => {
		const config = netlifyPoolConfig(connection);
		expect(config.max).toBe(1);
		expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
		expect(config.connectionString).not.toContain("sslmode");
	});
	it("rejects another database, role, or TLS override", () => {
		for (const input of [
			undefined,
			connection.replace("phhirxlgiwopfqzyxakm", "other"),
			connection.replace("geo_elmo_netlify_dyrep_r1", "postgres"),
			connection.replace("verify-full", "require"),
			`${connection}&sslcert=override`,
			connection.replace("/postgres?", "/other?"),
		]) {
			expect(() => netlifyPoolConfig(input)).toThrow();
		}
	});
});
