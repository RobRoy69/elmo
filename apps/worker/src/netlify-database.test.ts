import { describe, expect, it } from "vitest";
import { netlifyPoolConfig } from "../../../packages/lib/src/db/netlify-pool";
import { netlifyFailureReason } from "./netlify-cell-errors";

const connection =
	"postgresql://geo_elmo_netlify_dyrep_r1:test-only@db.phhirxlgiwopfqzyxakm.supabase.co:5432/postgres?sslmode=verify-full";

describe("Netlify database isolation", () => {
	it("accepts only the same preview role through the IPv4 session pooler", () => {
		const pooled = connection
			.replace("geo_elmo_netlify_dyrep_r1:", "geo_elmo_netlify_dyrep_r1.phhirxlgiwopfqzyxakm:")
			.replace("db.phhirxlgiwopfqzyxakm.supabase.co", "aws-1-eu-west-1.pooler.supabase.com");
		expect(netlifyPoolConfig(pooled).ssl).toMatchObject({ rejectUnauthorized: true });
		expect(() => netlifyPoolConfig(pooled.replace("phhirxlgiwopfqzyxakm:", "other:"))).toThrow();
		expect(() => netlifyPoolConfig(pooled.replace(":5432/", ":6543/"))).toThrow();
	});
	it("reports a safe nested failure category without exposing error text", () => {
		const cause = Object.assign(new Error("secret-database-connection"), { code: "ECONNREFUSED" });
		expect(netlifyFailureReason(new Error("sensitive query", { cause }))).toBe("database_unreachable");
		expect(netlifyFailureReason(new Error("secret-database-connection"))).toBe("runtime_unavailable");
	});
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
