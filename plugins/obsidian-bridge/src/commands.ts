/**
 * Contextual Study Commands for LearnHarness Obsidian Bridge Plugin.
 *
 * Implements:
 * - Study current note: reads active note, posts to /study-sessions.
 * - Study selection: reads active editor selection, posts to /study-sessions.
 * - Study folder: recursively collects notes, warns if >50 notes, posts to /study-sessions.
 * - Ask LearnHarness: submits question with note context to /ask.
 * - Graceful offline error handling with clean Obsidian Notices.
 */

import type {
	ObsidianAbstractFile,
	ObsidianEditor,
	ObsidianMarkdownView,
	ObsidianTFile,
	ObsidianTFolder,
	StudySessionResponse,
	AskQuestionResponse,
} from "./types.ts";
import { BridgeTransportError } from "./transport.ts";
import { AskQuestionModal, confirmLargeFolder, LargeFolderConfirmModal } from "./modals.ts";
import type { LearnHarnessBridgePlugin } from "./main.ts";

export function showNotice(
	plugin: LearnHarnessBridgePlugin,
	message: string,
	durationMs?: number,
): void {
	plugin.showNotice(message, durationMs);
}

export function handleBridgeError(
	plugin: LearnHarnessBridgePlugin,
	err: unknown,
	actionContext: string,
): void {
	if (err instanceof BridgeTransportError) {
		if (
			err.code === "ECONNREFUSED" ||
			err.code === "ETIMEDOUT" ||
			(err.message && /connection refused|timed out/i.test(err.message))
		) {
			showNotice(
				plugin,
				"LearnHarness is offline or unreachable. Please start LearnHarness to study notes.",
			);
			return;
		}
		if (err.status === 401 || err.code === "UNAUTHORIZED") {
			showNotice(
				plugin,
				"LearnHarness: Authentication required. Please check your API key in settings.",
			);
			return;
		}
		if (err.status === 403 || err.code === "FORBIDDEN") {
			showNotice(plugin, "LearnHarness: Access denied. Please verify project permissions.");
			return;
		}
		if (err.status === 404 || err.code === "NOT_FOUND") {
			showNotice(plugin, "LearnHarness: Service endpoint not found. Please verify LearnHarness version.");
			return;
		}
		if (err.code === "MISSING_PROJECT") {
			showNotice(
				plugin,
				"LearnHarness: No project selected. Please configure an active project in settings.",
			);
			return;
		}
	}

	const message = err instanceof Error ? err.message : String(err);
	if (/ECONNREFUSED|connection refused|ETIMEDOUT|timed out/i.test(message)) {
		showNotice(
			plugin,
			"LearnHarness is offline or unreachable. Please start LearnHarness to study notes.",
		);
		return;
	}

	showNotice(plugin, `LearnHarness Error (${actionContext}): ${message}`);
}

export function collectMarkdownFiles(folder: ObsidianTFolder): string[] {
	const results: string[] = [];

	function traverse(current: ObsidianAbstractFile): void {
		if ("children" in current && Array.isArray((current as ObsidianTFolder).children)) {
			for (const child of (current as ObsidianTFolder).children) {
				traverse(child);
			}
		} else {
			const file = current as ObsidianTFile;
			const isMd =
				(file.extension && file.extension.toLowerCase() === "md") ||
				file.name.toLowerCase().endsWith(".md");
			if (isMd) {
				results.push(file.path);
			}
		}
	}

	if (Array.isArray(folder.children)) {
		for (const child of folder.children) {
			traverse(child);
		}
	}

	return results;
}

export async function executeStudyCurrentNote(
	plugin: LearnHarnessBridgePlugin,
): Promise<StudySessionResponse | null> {
	if (!plugin.settings.activeProjectId?.trim()) {
		showNotice(
			plugin,
			"LearnHarness: No project selected. Please configure an active project in settings.",
		);
		return null;
	}

	const activeFile = plugin.app?.workspace?.getActiveFile?.();
	if (!activeFile) {
		showNotice(plugin, "LearnHarness: No active markdown note open.");
		return null;
	}

	const isMd =
		(activeFile.extension && activeFile.extension.toLowerCase() === "md") ||
		activeFile.name.toLowerCase().endsWith(".md");
	if (!isMd) {
		showNotice(plugin, "LearnHarness: Active file is not a markdown note.");
		return null;
	}

	const vaultName = plugin.app?.vault?.getName?.() || "DefaultVault";
	let content = "";
	if (plugin.app?.vault?.read) {
		try {
			content = await plugin.app.vault.read(activeFile);
		} catch (err) {
			handleBridgeError(plugin, err, "reading note");
			return null;
		}
	}

	try {
		const res = await plugin.transport.postStudyNote({
			vaultName,
			filePath: activeFile.path,
			content,
		});
		showNotice(
			plugin,
			`LearnHarness: Started study session for "${activeFile.basename || activeFile.name}"`,
		);
		return res;
	} catch (err) {
		handleBridgeError(plugin, err, "study note");
		return null;
	}
}

export async function executeStudySelection(
	plugin: LearnHarnessBridgePlugin,
	editor?: ObsidianEditor,
	view?: ObsidianMarkdownView,
): Promise<StudySessionResponse | null> {
	if (!plugin.settings.activeProjectId?.trim()) {
		showNotice(
			plugin,
			"LearnHarness: No project selected. Please configure an active project in settings.",
		);
		return null;
	}

	const targetEditor =
		editor ??
		view?.editor ??
		(plugin.app?.workspace?.getActiveViewOfType?.("markdown") as ObsidianMarkdownView | null)?.editor;

	if (!targetEditor) {
		showNotice(plugin, "LearnHarness: No active editor found.");
		return null;
	}

	const selection = targetEditor.getSelection?.()?.trim();
	if (!selection) {
		showNotice(plugin, "LearnHarness: No text selected to study.");
		return null;
	}

	const activeFile = view?.file ?? plugin.app?.workspace?.getActiveFile?.();
	const filePath = activeFile?.path ?? "Untitled.md";
	const vaultName = plugin.app?.vault?.getName?.() || "DefaultVault";

	let content = "";
	if (activeFile && plugin.app?.vault?.read) {
		try {
			content = await plugin.app.vault.read(activeFile);
		} catch {
			content = targetEditor.getValue?.() ?? "";
		}
	} else if (targetEditor.getValue) {
		content = targetEditor.getValue();
	}

	try {
		const res = await plugin.transport.postStudyNote({
			vaultName,
			filePath,
			content,
			selection,
		});
		showNotice(plugin, "LearnHarness: Started study session for selected text");
		return res;
	} catch (err) {
		handleBridgeError(plugin, err, "study selection");
		return null;
	}
}

export async function executeStudyFolder(
	plugin: LearnHarnessBridgePlugin,
	folder: ObsidianTFolder,
	confirmHandler?:
		| ((folderName: string, count: number) => Promise<boolean>)
		| LargeFolderConfirmModal,
): Promise<StudySessionResponse | null> {
	if (!plugin.settings.activeProjectId?.trim()) {
		showNotice(
			plugin,
			"LearnHarness: No project selected. Please configure an active project in settings.",
		);
		return null;
	}

	if (!folder || typeof folder !== "object") {
		showNotice(plugin, "LearnHarness: Invalid folder selected.");
		return null;
	}

	const filePaths = collectMarkdownFiles(folder);
	const noteCount = filePaths.length;

	if (noteCount === 0) {
		showNotice(plugin, `LearnHarness: Folder "${folder.name}" contains no markdown notes.`);
		return null;
	}

	if (noteCount > 50) {
		const confirmed = await confirmLargeFolder(folder.name, noteCount, confirmHandler);
		if (!confirmed) {
			showNotice(plugin, "LearnHarness: Folder study cancelled.");
			return null;
		}
	}

	const vaultName = plugin.app?.vault?.getName?.() || "DefaultVault";

	try {
		const res = await plugin.transport.postStudyFolder({
			vaultName,
			folderPath: folder.path,
			noteCount,
			filePaths,
		});
		showNotice(
			plugin,
			`LearnHarness: Started study session for folder "${folder.name}" (${noteCount} notes)`,
		);
		return res;
	} catch (err) {
		handleBridgeError(plugin, err, "study folder");
		return null;
	}
}

export interface AskLearnHarnessOptions {
	editor?: ObsidianEditor;
	view?: ObsidianMarkdownView;
	question?: string;
	modal?: AskQuestionModal;
}

export async function executeAskLearnHarness(
	plugin: LearnHarnessBridgePlugin,
	options?: AskLearnHarnessOptions,
): Promise<AskQuestionResponse | null> {
	if (!plugin.settings.activeProjectId?.trim()) {
		showNotice(
			plugin,
			"LearnHarness: No project selected. Please configure an active project in settings.",
		);
		return null;
	}

	const targetEditor =
		options?.editor ??
		options?.view?.editor ??
		(plugin.app?.workspace?.getActiveViewOfType?.("markdown") as ObsidianMarkdownView | null)?.editor;

	const selection = targetEditor?.getSelection?.()?.trim();
	const activeFile = options?.view?.file ?? plugin.app?.workspace?.getActiveFile?.();

	const context = {
		filePath: activeFile?.path,
		selection: selection || undefined,
	};

	// Programmatic / Direct Question Mode
	if (options?.question !== undefined) {
		const questionText = options.question.trim();
		if (!questionText) {
			showNotice(plugin, "LearnHarness: Question cannot be empty.");
			return null;
		}

		try {
			const res = await plugin.transport.postAskQuestion(questionText, context);
			showNotice(plugin, `LearnHarness Answer: ${res.answer}`);
			return res;
		} catch (err) {
			handleBridgeError(plugin, err, "ask question");
			return null;
		}
	}

	// Interactive Modal Mode
	const modal =
		options?.modal ??
		new AskQuestionModal(context, async (q, ctx) => {
			return plugin.transport.postAskQuestion(q, ctx);
		});

	void modal.open();
	return null;
}
