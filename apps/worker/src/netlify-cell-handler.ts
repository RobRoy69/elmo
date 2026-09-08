import { createHash, timingSafeEqual } from "node:crypto";

interface Settings {
	enabled?: string;
	token?: string;
	batchId?: string;
	requestHash?: string;
	target?: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function handleNetlifyCellBatch(
	request: Request,
	settings: Settings,
	execute: (batchId: string, requestHash: string) => Promise<string>,
): Promise<string> {
	if (settings.enabled !== "true") return "disabled";
	if (
		settings.target !== "dyrep-org" ||
		!settings.token ||
		settings.token.length < 32 ||
		!settings.batchId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settings.batchId) ||
		!settings.requestHash ||
		!/^sha256:[0-9a-f]{64}$/.test(settings.requestHash)
	) {
		return "unconfigured";
	}
	if (
		request.method !== "POST" ||
		!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${settings.token}`))
	)
		return "unauthorized";
	const reader = request.body?.getReader();
	if (!reader) return "invalid_request";
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > 1024) {
			await reader.cancel();
			return "invalid_request";
		}
		chunks.push(value);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return "invalid_request";
	}
	if (
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).join() !== "batchId" ||
		(body as { batchId: unknown }).batchId !== settings.batchId
	)
		return "invalid_request";
	return execute(settings.batchId, settings.requestHash);
}
