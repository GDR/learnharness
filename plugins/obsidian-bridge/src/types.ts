/**
 * Core domain contracts and settings for LearnHarness Obsidian Bridge Plugin.
 */

export interface BridgeSettings {
	serverUrl: string;
	apiKey?: string;
	activeProjectId?: string;
	vaultId?: string;
	registeredVaultId?: string;
	largeFolderThreshold?: number;
	autoRegisterVault?: boolean;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
	serverUrl: "http://127.0.0.1:3000",
	largeFolderThreshold: 50,
	autoRegisterVault: true,
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
export interface StudyFolderCommandPayload {
	vaultName: string;
	folderPath: string;
	noteCount: number;
	filePaths: string[];
}

export interface ObsidianAbstractFile {
	path: string;
	name: string;
}

export interface ObsidianTFile extends ObsidianAbstractFile {
	extension: string;
	basename: string;
}

export interface ObsidianTFolder extends ObsidianAbstractFile {
	children: ObsidianAbstractFile[];
}

export interface ObsidianEditorPosition {
	line: number;
	ch: number;
}

export interface ObsidianEditor {
	getSelection(): string;
	getValue(): string;
	getCursor?(type?: string): ObsidianEditorPosition;
}

export interface ObsidianMarkdownView {
	file?: ObsidianTFile | null;
	editor: ObsidianEditor;
}

export interface ObsidianMenuItem {
	setTitle(title: string): this;
	setIcon(icon: string): this;
	onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown): this;
}

export interface ObsidianMenu {
	addItem(cb: (item: ObsidianMenuItem) => unknown): this;
}

export interface ObsidianEventRef {
	id?: string;
}

export interface ObsidianWorkspace {
	getActiveFile?(): ObsidianTFile | null;
	getActiveViewOfType?<T>(type: unknown): T | null;
	on?(name: "file-menu", callback: (menu: ObsidianMenu, file: ObsidianAbstractFile, source?: string) => unknown): ObsidianEventRef;
	on?(name: "editor-menu", callback: (menu: ObsidianMenu, editor: ObsidianEditor, view: ObsidianMarkdownView) => unknown): ObsidianEventRef;
	on?(name: string, callback: (...args: any[]) => unknown): ObsidianEventRef;
	offref?(ref: ObsidianEventRef): void;
}

export interface ObsidianAdapter {
	getBasePath?(): string | undefined;
	basePath?: string;
	[key: string]: unknown;
}

export interface ObsidianVault {
	getName(): string;
	read?(file: ObsidianTFile): Promise<string>;
	getAbstractFileByPath?(path: string): ObsidianAbstractFile | null;
	adapter?: ObsidianAdapter;
}

export interface ProjectSummary {
	id: string;
	name: string;
	description?: string;
	isArchived?: boolean;
	createdAt?: string;
	updatedAt?: string;
}

export interface ProjectListResponse {
	projects: ProjectSummary[];
	activeProjectId?: string;
}

export interface VaultBindingSummary {
	deviceId: string;
	rootPath: string;
	status: "available" | "unavailable";
}

export interface VaultSummary {
	id: string;
	displayName: string;
	kind?: string;
	bindings?: VaultBindingSummary[];
	createdAt?: string;
	updatedAt?: string;
}

export interface VaultRegistrationPayload {
	id?: string;
	displayName: string;
	path?: string;
	rootPath?: string;
	deviceId?: string;
	kind?: "local" | "remote";
}

export interface VaultRegistrationResponse {
	vault: VaultSummary;
}

export interface ObsidianSettingTab {
	app?: ObsidianApp;
	containerEl?: HTMLElement;
	display(): void;
	hide?(): void;
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

export interface NoticeHandler {
	(message: string, durationMs?: number): void;
}

export interface ObsidianApp {
	vault?: ObsidianVault;
	workspace?: ObsidianWorkspace;
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
