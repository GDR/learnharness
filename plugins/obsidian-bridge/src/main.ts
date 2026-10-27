import type {
	BridgeSettings,
	ObsidianAbstractFile,
	ObsidianApp,
	ObsidianCommand,
	ObsidianEditor,
	ObsidianEventRef,
	ObsidianMarkdownView,
	ObsidianMenu,
	ObsidianMenuItem,
	ObsidianStatusBarItem,
	ObsidianTFile,
	ObsidianTFolder,
	PluginManifest,
} from "./types.ts";
import { DEFAULT_BRIDGE_SETTINGS } from "./types.ts";
import { BridgeTransport } from "./transport.ts";
import {
	executeStudyCurrentNote,
	executeStudySelection,
	executeStudyFolder,
	executeAskLearnHarness,
} from "./commands.ts";

export class LearnHarnessBridgePlugin {
	public app?: ObsidianApp;
	public manifest: PluginManifest;
	public settings: BridgeSettings;
	public transport: BridgeTransport;
	public statusBarItem?: ObsidianStatusBarItem;
	public commands: Map<string, ObsidianCommand> = new Map();
	public eventRefs: ObsidianEventRef[] = [];
	public lastNotice?: string;
	public notices: string[] = [];
	public isLoaded = false;

	constructor(app?: ObsidianApp, manifest?: Partial<PluginManifest>) {
		this.app = app;
		this.manifest = {
			id: manifest?.id ?? "learnharness-bridge",
			name: manifest?.name ?? "LearnHarness Bridge",
			version: manifest?.version ?? "1.0.0",
			minAppVersion: manifest?.minAppVersion ?? "1.0.0",
			description:
				manifest?.description ??
				"Bridge plugin connecting Obsidian notes to LearnHarness workspace learning sessions and graphs.",
			author: manifest?.author ?? "LearnHarness",
			isDesktopOnly: manifest?.isDesktopOnly ?? true,
		};
		this.settings = { ...DEFAULT_BRIDGE_SETTINGS };
		this.transport = new BridgeTransport(this.settings);
	}

	public showNotice(message: string, durationMs?: number): void {
		this.lastNotice = message;
		this.notices.push(message);
		const globalNotice = (globalThis as unknown as {
			Notice?: new (msg: string, dur?: number) => unknown;
		}).Notice;
		if (typeof globalNotice === "function") {
			try {
				new globalNotice(message, durationMs);
			} catch {
				// Non-intrusive fallback if Notice constructor fails in non-DOM environment
			}
		}
	}

	public async onload(): Promise<void> {
		await this.loadSettings();
		this.transport = new BridgeTransport(this.settings);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("LearnHarness: Ready");

		// Connection status check command
		this.addCommand({
			id: "learnharness:check-health",
			name: "LearnHarness: Check Connection Status",
			callback: async () => {
				try {
					const health = await this.transport.checkHealth();
					this.statusBarItem?.setText(
						`LearnHarness: ${health.ok ? "Connected" : "Disconnected"}`,
					);
					return health;
				} catch {
					this.statusBarItem?.setText("LearnHarness: Error");
					this.showNotice("LearnHarness: Offline or unreachable");
				}
			},
		});

		// Study current active note command
		this.addCommand({
			id: "learnharness:study-current-note",
			name: "LearnHarness: Study Current Note",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app?.workspace?.getActiveFile?.();
				const isMd =
					(activeFile?.extension && activeFile.extension.toLowerCase() === "md") ||
					(activeFile?.name && activeFile.name.toLowerCase().endsWith(".md"));
				if (checking) {
					return !!isMd;
				}
				void executeStudyCurrentNote(this);
				return true;
			},
		});

		// Study selection command
		this.addCommand({
			id: "learnharness:study-selection",
			name: "LearnHarness: Study Selection",
			checkCallback: (checking: boolean) => {
				const view = this.app?.workspace?.getActiveViewOfType?.("markdown") as
					| ObsidianMarkdownView
					| null
					| undefined;
				const activeFile = view?.file ?? this.app?.workspace?.getActiveFile?.();
				const isMd =
					(activeFile?.extension && activeFile.extension.toLowerCase() === "md") ||
					(activeFile?.name && activeFile.name.toLowerCase().endsWith(".md"));
				if (checking) {
					return !!(view || isMd);
				}
				if (view?.editor) {
					void executeStudySelection(this, view.editor, view);
				} else {
					void executeStudySelection(this);
				}
				return true;
			},
		});

		// Ask LearnHarness command
		this.addCommand({
			id: "learnharness:ask-learnharness",
			name: "LearnHarness: Ask LearnHarness",
			callback: () => {
				void executeAskLearnHarness(this);
			},
		});

		// Alias for backward compatibility with Slice E.1
		this.addCommand({
			id: "learnharness:ask-about-selection",
			name: "LearnHarness: Ask About Selection",
			callback: () => {
				void executeAskLearnHarness(this);
			},
		});

		// Register workspace context menus (file-menu and editor-menu)
		if (this.app?.workspace?.on) {
			const fileMenuRef = this.app.workspace.on(
				"file-menu",
				(menu: ObsidianMenu, file: ObsidianAbstractFile) => {
					if ("children" in file && Array.isArray((file as ObsidianTFolder).children)) {
						menu.addItem((item: ObsidianMenuItem) => {
							item.setTitle("LearnHarness: Study folder");
							item.setIcon("folder");
							item.onClick(() => {
								return executeStudyFolder(this, file as ObsidianTFolder);
							});
						});
					} else {
						const isMd =
							((file as ObsidianTFile).extension &&
								(file as ObsidianTFile).extension.toLowerCase() === "md") ||
							file.name.toLowerCase().endsWith(".md");
						if (isMd) {
							menu.addItem((item: ObsidianMenuItem) => {
								item.setTitle("LearnHarness: Study note");
								item.setIcon("document");
								item.onClick(() => {
									return executeStudyCurrentNote(this, file as ObsidianTFile);
								});
							});
						}
					}
				},
			);
			if (fileMenuRef) {
				this.eventRefs.push(fileMenuRef);
			}

			const editorMenuRef = this.app.workspace.on(
				"editor-menu",
				(menu: ObsidianMenu, editor: ObsidianEditor, view: ObsidianMarkdownView) => {
					const selection = editor.getSelection?.()?.trim();
					if (!selection) {
						return;
					}

					menu.addItem((item: ObsidianMenuItem) => {
						item.setTitle("LearnHarness: Study selection");
						item.setIcon("text-select");
						item.onClick(() => {
							return executeStudySelection(this, editor, view);
						});
					});

					menu.addItem((item: ObsidianMenuItem) => {
						item.setTitle("LearnHarness: Ask LearnHarness about selection");
						item.setIcon("help-circle");
						item.onClick(() => {
							return executeAskLearnHarness(this, { editor, view });
						});
					});
				},
			);
			if (editorMenuRef) {
				this.eventRefs.push(editorMenuRef);
			}
		}

		this.isLoaded = true;
	}

	public async onunload(): Promise<void> {
		if (this.statusBarItem?.remove) {
			this.statusBarItem.remove();
		}
		this.statusBarItem = undefined;

		if (this.app?.workspace?.offref) {
			for (const ref of this.eventRefs) {
				this.app.workspace.offref(ref);
			}
		}
		this.eventRefs = [];

		this.commands.clear();
		this.isLoaded = false;
	}

	public async loadSettings(): Promise<BridgeSettings> {
		const raw = (await this.loadData()) as Partial<BridgeSettings> | null | undefined;
		this.settings = {
			...DEFAULT_BRIDGE_SETTINGS,
			...(raw && typeof raw === "object" ? raw : {}),
		};
		return this.settings;
	}

	public async saveSettings(patch?: Partial<BridgeSettings>): Promise<void> {
		if (patch) {
			this.settings = { ...this.settings, ...patch };
		}
		this.transport.updateSettings(this.settings);
		await this.saveData(this.settings);
	}

	public addCommand(command: ObsidianCommand): ObsidianCommand {
		this.commands.set(command.id, command);
		return command;
	}

	public addStatusBarItem(): ObsidianStatusBarItem {
		let currentText = "";
		const item: ObsidianStatusBarItem = {
			setText: (text: string) => {
				currentText = text;
			},
			remove: () => {
				currentText = "";
			},
		};
		// Getter for test inspectability
		Object.defineProperty(item, "text", {
			get: () => currentText,
			enumerable: true,
		});
		return item;
	}

	// Mockable persistence hooks (overridden by Obsidian's Plugin base class in runtime)
	public async loadData(): Promise<unknown> {
		return { ...this.settings };
	}

	public async saveData(data: unknown): Promise<void> {
		if (data && typeof data === "object") {
			this.settings = { ...this.settings, ...(data as Partial<BridgeSettings>) };
		}
	}
}

export default LearnHarnessBridgePlugin;
