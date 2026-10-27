import type {
	BridgeSettings,
	ObsidianApp,
	ObsidianCommand,
	ObsidianStatusBarItem,
	PluginManifest,
} from "./types.ts";
import { DEFAULT_BRIDGE_SETTINGS } from "./types.ts";
import { BridgeTransport } from "./transport.ts";

export class LearnHarnessBridgePlugin {
	public app?: ObsidianApp;
	public manifest: PluginManifest;
	public settings: BridgeSettings;
	public transport: BridgeTransport;
	public statusBarItem?: ObsidianStatusBarItem;
	public commands: Map<string, ObsidianCommand> = new Map();
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

	public async onload(): Promise<void> {
		await this.loadSettings();
		this.transport = new BridgeTransport(this.settings);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("LearnHarness: Ready");

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
				} catch (err) {
					this.statusBarItem?.setText("LearnHarness: Error");
					throw err;
				}
			},
		});

		this.addCommand({
			id: "learnharness:study-current-note",
			name: "LearnHarness: Study Current Note",
			callback: async () => {
				// Contextual command stub wired in Slice E.2
				return { command: "study-current-note", status: "ready" };
			},
		});

		this.addCommand({
			id: "learnharness:ask-about-selection",
			name: "LearnHarness: Ask About Selection",
			callback: async () => {
				// Contextual command stub wired in Slice E.2
				return { command: "ask-about-selection", status: "ready" };
			},
		});

		this.isLoaded = true;
	}

	public async onunload(): Promise<void> {
		if (this.statusBarItem?.remove) {
			this.statusBarItem.remove();
		}
		this.statusBarItem = undefined;
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
