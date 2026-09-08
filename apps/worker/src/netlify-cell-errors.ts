const reasons: Record<string, string> = {
	ERR_MODULE_NOT_FOUND: "dependency_unavailable",
	ECONNREFUSED: "database_unreachable",
	ENOTFOUND: "database_host_unavailable",
	ENETUNREACH: "database_network_unavailable",
	ETIMEDOUT: "database_timeout",
	"28P01": "database_login_failed",
	"42501": "database_permission_denied",
	DEPTH_ZERO_SELF_SIGNED_CERT: "database_tls_failed",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "database_tls_failed",
	SELF_SIGNED_CERT_IN_CHAIN: "database_tls_failed",
	ERR_TLS_CERT_ALTNAME_INVALID: "database_tls_failed",
};

export function netlifyFailureReason(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		const code = "code" in current ? current.code : undefined;
		if (typeof code === "string" && Object.hasOwn(reasons, code)) return reasons[code];
		current = current.cause;
	}
	return "runtime_unavailable";
}
