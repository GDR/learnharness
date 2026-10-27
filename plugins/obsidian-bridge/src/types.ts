/**
 * Core domain contracts and settings for LearnHarness Obsidian Bridge Plugin.
 */

export interface BridgeSettings {
	serverUrl: string;
	apiKey?: string;
	activeProjectId?: string;
	vaultId?: string;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
	serverUrl: "http://127.0.0.1:3000",
};

export interface BridgeHealthStatus {
	ok: boolean;
	version?: string;
	activeProject?: string;
	error?: string;
}

export interface StudyNoteCommandPayload {
	vaultName: string;
	filePath: string;
	content: string;
	selection?: string;
	heading?: string;
}

export interface StudySessionResponse {
	sessionId: string;
}

export interface AskQuestionResponse {
	answer: string;
}

export interface ObsidianCommand {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
}

export interface ObsidianStatusBarItem {
	setText(text: string): void;
	remove?(): void;
}

export interface ObsidianApp {
	vault?: {
		getName?: () => string;
	};
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	author: string;
	isDesktopOnly?: boolean;
}
