import type {
	BridgeHealthStatus,
	BridgeSettings,
	StudyNoteCommandPayload,
	StudyFolderCommandPayload,
	StudySessionResponse,
	AskQuestionResponse,
} from "./types.ts";
import { DEFAULT_BRIDGE_SETTINGS } from "./types.ts";

export class BridgeTransportError extends Error {
	readonly status?: number;
	readonly code?: string;

	constructor(message: string, options?: { status?: number; code?: string; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "BridgeTransportError";
		this.status = options?.status;
		this.code = options?.code;
	}
}

export function isLoopbackUrl(urlStr: string): boolean {
	try {
		const parsed = new URL(urlStr);
		const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/.test(host)
		);
	} catch {
		return false;
	}
}

export class BridgeTransport {
	private settings: BridgeSettings;

	constructor(settings?: Partial<BridgeSettings>) {
		this.settings = { ...DEFAULT_BRIDGE_SETTINGS, ...settings };
		this.validateConfiguration();
	}

	public getSettings(): Readonly<BridgeSettings> {
		return { ...this.settings };
	}

	public updateSettings(patch: Partial<BridgeSettings>): void {
		this.settings = { ...this.settings, ...patch };
		this.validateConfiguration();
	}

	private validateConfiguration(): void {
		const rawUrl = this.settings.serverUrl?.trim();
		if (!rawUrl) {
			throw new BridgeTransportError("serverUrl is required in BridgeSettings", {
				code: "INVALID_CONFIG",
			});
		}

		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			throw new BridgeTransportError(`Invalid serverUrl format: ${rawUrl}`, {
				code: "INVALID_URL",
			});
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new BridgeTransportError(`Unsupported protocol: ${parsed.protocol}. Must be http: or https:`, {
				code: "INVALID_PROTOCOL",
			});
		}

		const isLoopback = isLoopbackUrl(rawUrl);
		if (!isLoopback) {
			if (parsed.protocol === "http:") {
				throw new BridgeTransportError(
					`Insecure remote endpoint ${rawUrl} rejected. Remote server must use HTTPS.`,
					{ code: "SECURITY_VIOLATION" },
				);
			}
			if (!this.settings.apiKey || !this.settings.apiKey.trim()) {
				throw new BridgeTransportError(
					`Remote endpoint ${rawUrl} rejected without credentials. An API key is required for non-loopback connections.`,
					{ code: "AUTHENTICATION_REQUIRED" },
				);
			}
		}
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Accept": "application/json",
			"Content-Type": "application/json",
		};

		if (this.settings.apiKey?.trim()) {
			const key = this.settings.apiKey.trim();
			headers["Authorization"] = `Bearer ${key}`;
			headers["x-api-key"] = key;
		}

		return headers;
	}

	private async executeRequest<T>(
		endpoint: string,
		options: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
	): Promise<T> {
		this.validateConfiguration();
		const base = this.settings.serverUrl.replace(/\/+$/, "");
		const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
		const fullUrl = `${base}${cleanEndpoint}`;

		const timeoutMs = options.timeoutMs ?? 15000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await fetch(fullUrl, {
				method: options.method,
				headers: this.getHeaders(),
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
				signal: controller.signal,
			});

			if (!res.ok) {
				let serverError: string | undefined;
				try {
					const data = (await res.json()) as { error?: string; message?: string };
					serverError = data.error || data.message;
				} catch {
					// body not JSON
				}

				if (res.status === 401) {
					throw new BridgeTransportError(
						`Unauthorized (401): Missing or invalid API key for LearnHarness bridge.${serverError ? ` Server: ${serverError}` : ""}`,
						{ status: 401, code: "UNAUTHORIZED" },
					);
				}
				if (res.status === 403) {
					throw new BridgeTransportError(
						`Forbidden (403): Access denied to LearnHarness bridge endpoint.${serverError ? ` Server: ${serverError}` : ""}`,
						{ status: 403, code: "FORBIDDEN" },
					);
				}
				if (res.status === 404) {
					throw new BridgeTransportError(
						`Not Found (404): LearnHarness endpoint not found at ${cleanEndpoint}.${serverError ? ` Server: ${serverError}` : ""}`,
						{ status: 404, code: "NOT_FOUND" },
					);
				}

				throw new BridgeTransportError(
					`HTTP error ${res.status}: ${serverError || res.statusText || "Request failed"}`,
					{ status: res.status, code: `HTTP_${res.status}` },
				);
			}

			return (await res.json()) as T;
		} catch (err) {
			if (err instanceof BridgeTransportError) {
				throw err;
			}

			const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
			if (e.name === "AbortError" || e.name === "TimeoutError" || controller.signal.aborted) {
				throw new BridgeTransportError(
					`Request timed out after ${timeoutMs}ms connecting to ${base}`,
					{ code: "ETIMEDOUT", cause: err },
				);
			}

			const isConnRefused =
				e.code === "ECONNREFUSED" ||
				e.cause?.code === "ECONNREFUSED" ||
				String(e.message).includes("ECONNREFUSED") ||
				String(e.cause?.message).includes("ECONNREFUSED");

			if (isConnRefused) {
				throw new BridgeTransportError(
					`Connection refused: Unable to connect to LearnHarness at ${base}. Please ensure LearnHarness is running.`,
					{ code: "ECONNREFUSED", cause: err },
				);
			}

			throw new BridgeTransportError(
				`Network request failed to ${base}: ${e.message || String(err)}`,
				{ code: "ENETWORK", cause: err },
			);
		} finally {
			clearTimeout(timer);
		}
	}

	public async checkHealth(options?: {
		timeoutMs?: number;
		throwOnError?: boolean;
	}): Promise<BridgeHealthStatus> {
		const timeoutMs = options?.timeoutMs ?? 5000;
		const throwOnError = options?.throwOnError ?? true;

		try {
			let data: { ok?: boolean; version?: string; activeProject?: unknown; activeProjectId?: string };
			try {
				data = await this.executeRequest<{ ok?: boolean; version?: string; activeProject?: unknown; activeProjectId?: string }>(
					"/api/health",
					{ method: "GET", timeoutMs },
				);
			} catch (firstErr) {
				if (firstErr instanceof BridgeTransportError && firstErr.status === 404) {
					// Fallback to /api/projects/active if /api/health is not defined on server
					data = await this.executeRequest<{ ok?: boolean; version?: string; activeProject?: unknown; activeProjectId?: string }>(
						"/api/projects/active",
						{ method: "GET", timeoutMs },
					);
				} else {
					throw firstErr;
				}
			}

			let activeProjectName: string | undefined;
			if (typeof data.activeProject === "string") {
				activeProjectName = data.activeProject;
			} else if (data.activeProject && typeof data.activeProject === "object" && "name" in data.activeProject) {
				activeProjectName = String((data.activeProject as { name: unknown }).name);
			} else if (data.activeProjectId) {
				activeProjectName = data.activeProjectId;
			}

			return {
				ok: true,
				version: typeof data.version === "string" ? data.version : "1.0.0",
				activeProject: activeProjectName,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (throwOnError) {
				throw err;
			}
			return {
				ok: false,
				error: message,
			};
		}
	}

	public async postStudyNote(payload: StudyNoteCommandPayload): Promise<StudySessionResponse> {
		if (!payload || typeof payload !== "object") {
			throw new BridgeTransportError("Payload must be a valid object", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.vaultName !== "string" || !payload.vaultName.trim()) {
			throw new BridgeTransportError("vaultName must be a non-empty string", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.filePath !== "string" || !payload.filePath.trim()) {
			throw new BridgeTransportError("filePath must be a non-empty string", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.content !== "string") {
			throw new BridgeTransportError("content must be a string", { code: "INVALID_PAYLOAD" });
		}

		const projectId = this.settings.activeProjectId?.trim();
		const endpoint = projectId
			? `/api/projects/${encodeURIComponent(projectId)}/study-sessions`
			: "/api/projects/active/study-sessions";

		const body = {
			...payload,
			vaultId: this.settings.vaultId,
		};

		return this.executeRequest<StudySessionResponse>(endpoint, {
			method: "POST",
			body,
		});
	}

	public async postStudyFolder(payload: StudyFolderCommandPayload): Promise<StudySessionResponse> {
		if (!payload || typeof payload !== "object") {
			throw new BridgeTransportError("Payload must be a valid object", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.vaultName !== "string" || !payload.vaultName.trim()) {
			throw new BridgeTransportError("vaultName must be a non-empty string", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.folderPath !== "string") {
			throw new BridgeTransportError("folderPath must be a string", { code: "INVALID_PAYLOAD" });
		}
		if (typeof payload.noteCount !== "number" || payload.noteCount < 0) {
			throw new BridgeTransportError("noteCount must be a non-negative number", { code: "INVALID_PAYLOAD" });
		}

		const projectId = this.settings.activeProjectId?.trim();
		const endpoint = projectId
			? `/api/projects/${encodeURIComponent(projectId)}/study-sessions`
			: "/api/projects/active/study-sessions";

		const body = {
			...payload,
			vaultId: this.settings.vaultId,
			scopeType: "folder",
		};

		return this.executeRequest<StudySessionResponse>(endpoint, {
			method: "POST",
			body,
		});
	}

	public async postAskQuestion(question: string, context?: unknown): Promise<AskQuestionResponse> {
		if (typeof question !== "string" || !question.trim()) {
			throw new BridgeTransportError("question must be a non-empty string", { code: "INVALID_PAYLOAD" });
		}

		const projectId = this.settings.activeProjectId?.trim();
		const endpoint = projectId
			? `/api/projects/${encodeURIComponent(projectId)}/ask`
			: "/api/projects/active/ask";

		const body = {
			question: question.trim(),
			context,
			vaultId: this.settings.vaultId,
		};

		return this.executeRequest<AskQuestionResponse>(endpoint, {
			method: "POST",
			body,
		});
	}
}
