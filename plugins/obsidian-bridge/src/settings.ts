/**
 * Setting Tab UI for LearnHarness Obsidian Bridge Plugin.
 *
 * Implements LearnHarnessSettingTab:
 * 1. Connection settings (serverUrl, apiKey) with live "Test Connection" status indicator.
 * 2. Vault identity & registration status with "Register / Re-verify Vault" action.
 * 3. Project targeting dropdown bound to GET /api/projects with instant persistence to data.json.
 * 4. Inline "+ New Project" creation dialog.
 * 5. Configurable large-folder warning threshold (default: 50).
 */

import type {
	BridgeHealthStatus,
	ObsidianApp,
	ObsidianSettingTab,
	ProjectSummary,
	VaultSummary,
} from "./types.ts";
import type { LearnHarnessBridgePlugin } from "./main.ts";
import { getVaultRootPath, ensureVaultRegistered } from "./vault.ts";
import { NewProjectModal } from "./modals.ts";

export class LearnHarnessSettingTab implements ObsidianSettingTab {
	public app?: ObsidianApp;
	public plugin: LearnHarnessBridgePlugin;
	public containerEl?: HTMLElement;
	public projects: ProjectSummary[] = [];

	public connectionStatusEl?: HTMLElement;
	public vaultStatusEl?: HTMLElement;
	public projectSelectEl?: HTMLSelectElement;
	public vaultIdDisplayEl?: HTMLElement;

	constructor(app: ObsidianApp | undefined, plugin: LearnHarnessBridgePlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	public display(): void {
		if (!this.containerEl && typeof document !== "undefined") {
			this.containerEl = document.createElement("div");
		}
		if (!this.containerEl) {
			return;
		}

		const container = this.containerEl;
		if (typeof (container as unknown as { empty?: () => void }).empty === "function") {
			(container as unknown as { empty: () => void }).empty();
		} else {
			container.innerHTML = "";
		}

		container.classList.add("learnharness-settings-container");

		// Header
		const header = document.createElement("h2");
		header.className = "learnharness-settings-title";
		header.textContent = "LearnHarness Bridge Settings";
		container.appendChild(header);

		const intro = document.createElement("p");
		intro.className = "setting-item-description";
		intro.textContent =
			"Configure connection, vault registration, and target project workspace for study sessions.";
		container.appendChild(intro);

		// Section 1: Connection & Status
		this.renderConnectionSection(container);

		// Section 2: Vault Identity & Registration
		this.renderVaultSection(container);

		// Section 3: Project Targeting (Per-Vault Memory)
		this.renderProjectSection(container);

		// Section 4: Safety & Thresholds
		this.renderSafetySection(container);
	}

	public hide(): void {
		// Cleanup if needed
	}

	private renderConnectionSection(container: HTMLElement): void {
		const sectionHeader = document.createElement("h3");
		sectionHeader.textContent = "Connection & Status";
		container.appendChild(sectionHeader);

		// Server URL
		const urlItem = document.createElement("div");
		urlItem.className = "setting-item learnharness-setting-item";

		const urlInfo = document.createElement("div");
		urlInfo.className = "setting-item-info";
		const urlName = document.createElement("div");
		urlName.className = "setting-item-name";
		urlName.textContent = "Server URL";
		const urlDesc = document.createElement("div");
		urlDesc.className = "setting-item-description";
		urlDesc.textContent = "LearnHarness server address (loopback or remote HTTPS endpoint).";
		urlInfo.appendChild(urlName);
		urlInfo.appendChild(urlDesc);

		const urlControl = document.createElement("div");
		urlControl.className = "setting-item-control";
		const urlInput = document.createElement("input");
		urlInput.type = "text";
		urlInput.className = "learnharness-input learnharness-server-url-input";
		urlInput.placeholder = "http://127.0.0.1:3000";
		urlInput.value = this.plugin.settings.serverUrl || "http://127.0.0.1:3000";

		const saveUrl = () => {
			this.plugin.settings.serverUrl = urlInput.value.trim() || "http://127.0.0.1:3000";
			void this.plugin.saveSettings();
		};
		urlInput.onchange = saveUrl;
		urlInput.onblur = saveUrl;

		urlControl.appendChild(urlInput);
		urlItem.appendChild(urlInfo);
		urlItem.appendChild(urlControl);
		container.appendChild(urlItem);

		// API Key
		const keyItem = document.createElement("div");
		keyItem.className = "setting-item learnharness-setting-item";

		const keyInfo = document.createElement("div");
		keyInfo.className = "setting-item-info";
		const keyName = document.createElement("div");
		keyName.className = "setting-item-name";
		keyName.textContent = "API Key";
		const keyDesc = document.createElement("div");
		keyDesc.className = "setting-item-description";
		keyDesc.textContent = "Authentication credentials (required for remote endpoints).";
		keyInfo.appendChild(keyName);
		keyInfo.appendChild(keyDesc);

		const keyControl = document.createElement("div");
		keyControl.className = "setting-item-control";
		const keyInput = document.createElement("input");
		keyInput.type = "password";
		keyInput.className = "learnharness-input learnharness-api-key-input";
		keyInput.placeholder = "Enter API key";
		keyInput.value = this.plugin.settings.apiKey || "";

		const saveKey = () => {
			this.plugin.settings.apiKey = keyInput.value.trim() || undefined;
			void this.plugin.saveSettings();
		};
		keyInput.onchange = saveKey;
		keyInput.onblur = saveKey;

		keyControl.appendChild(keyInput);
		keyItem.appendChild(keyInfo);
		keyItem.appendChild(keyControl);
		container.appendChild(keyItem);

		// Connection Test
		const testItem = document.createElement("div");
		testItem.className = "setting-item learnharness-setting-item";

		const testInfo = document.createElement("div");
		testInfo.className = "setting-item-info";
		const testName = document.createElement("div");
		testName.className = "setting-item-name";
		testName.textContent = "Test Connection";
		const testDesc = document.createElement("div");
		testDesc.className = "setting-item-description";
		testDesc.textContent = "Verify connectivity to LearnHarness backend.";
		testInfo.appendChild(testName);
		testInfo.appendChild(testDesc);

		const testControl = document.createElement("div");
		testControl.className = "setting-item-control";

		const testBtn = document.createElement("button");
		testBtn.className = "learnharness-test-conn-btn mod-cta";
		testBtn.textContent = "Test Connection";
		testBtn.onclick = () => void this.testConnection();

		const statusSpan = document.createElement("span");
		statusSpan.className = "learnharness-conn-status";
		statusSpan.style.marginLeft = "12px";
		statusSpan.textContent = "● Status: Untested";
		this.connectionStatusEl = statusSpan;

		testControl.appendChild(testBtn);
		testControl.appendChild(statusSpan);
		testItem.appendChild(testInfo);
		testItem.appendChild(testControl);
		container.appendChild(testItem);
	}

	private renderVaultSection(container: HTMLElement): void {
		const sectionHeader = document.createElement("h3");
		sectionHeader.textContent = "Vault Registration";
		container.appendChild(sectionHeader);

		const vaultName = this.plugin.app?.vault?.getName?.() || "DefaultVault";
		const rootPath = getVaultRootPath(this.plugin.app) || "Unavailable (virtual/mobile)";
		const vaultId =
			this.plugin.settings.vaultId || this.plugin.settings.registeredVaultId || "Not registered";

		const vaultItem = document.createElement("div");
		vaultItem.className = "setting-item learnharness-setting-item";

		const vaultInfo = document.createElement("div");
		vaultInfo.className = "setting-item-info";

		const nameLine = document.createElement("div");
		nameLine.className = "setting-item-description";
		nameLine.textContent = `Vault Name: ${vaultName}`;

		const pathLine = document.createElement("div");
		pathLine.className = "setting-item-description";
		pathLine.textContent = `Vault Root: ${rootPath}`;

		const idLine = document.createElement("div");
		idLine.className = "setting-item-description learnharness-vault-id-display";
		idLine.textContent = `Vault ID: ${vaultId}`;
		this.vaultIdDisplayEl = idLine;

		vaultInfo.appendChild(nameLine);
		vaultInfo.appendChild(pathLine);
		vaultInfo.appendChild(idLine);

		const vaultControl = document.createElement("div");
		vaultControl.className = "setting-item-control";

		const registerBtn = document.createElement("button");
		registerBtn.className = "learnharness-register-vault-btn";
		registerBtn.textContent = "Register / Re-verify Vault";
		registerBtn.onclick = () => void this.registerVault();

		const vaultStatus = document.createElement("span");
		vaultStatus.className = "learnharness-vault-status";
		vaultStatus.style.marginLeft = "12px";
		vaultStatus.textContent = this.plugin.settings.vaultId
			? "● Registered"
			: "● Not registered";
		this.vaultStatusEl = vaultStatus;

		vaultControl.appendChild(registerBtn);
		vaultControl.appendChild(vaultStatus);
		vaultItem.appendChild(vaultInfo);
		vaultItem.appendChild(vaultControl);
		container.appendChild(vaultItem);
	}

	private renderProjectSection(container: HTMLElement): void {
		const sectionHeader = document.createElement("h3");
		sectionHeader.textContent = "Project Targeting (Per-Vault Memory)";
		container.appendChild(sectionHeader);

		const projectItem = document.createElement("div");
		projectItem.className = "setting-item learnharness-setting-item";

		const projectInfo = document.createElement("div");
		projectInfo.className = "setting-item-info";
		const projectName = document.createElement("div");
		projectName.className = "setting-item-name";
		projectName.textContent = "Target Project";
		const projectDesc = document.createElement("div");
		projectDesc.className = "setting-item-description";
		projectDesc.textContent =
			"Select which LearnHarness project workspace this Obsidian vault targets.";
		projectInfo.appendChild(projectName);
		projectInfo.appendChild(projectDesc);

		const projectControl = document.createElement("div");
		projectControl.className = "setting-item-control";

		const select = document.createElement("select");
		select.className = "dropdown learnharness-project-select";
		this.projectSelectEl = select;

		const saveProjectChoice = () => {
			const selectEl = select as HTMLSelectElement & { selectedIndex?: number; options?: HTMLOptionElement[] };
			let selectedVal = typeof selectEl.value === "string" ? selectEl.value.trim() : "";
			if (!selectedVal && selectEl.options && typeof selectEl.selectedIndex === "number" && selectEl.selectedIndex >= 0) {
				selectedVal = selectEl.options[selectEl.selectedIndex]?.value?.trim() || "";
			}
			this.plugin.settings.activeProjectId = selectedVal || undefined;
			void this.plugin.saveSettings();

			// Auto attach vault to project if configured
			if (selectedVal && this.plugin.settings.vaultId) {
				void this.plugin.transport
					.attachVaultToProject(selectedVal, this.plugin.settings.vaultId)
					.catch(() => {});
			}
		};
		select.onchange = saveProjectChoice;
		if (typeof select.addEventListener === "function") {
			select.addEventListener("change", saveProjectChoice);
		}

		this.renderProjectDropdownOptions();

		const refreshBtn = document.createElement("button");
		refreshBtn.className = "learnharness-refresh-projects-btn";
		refreshBtn.textContent = "Refresh";
		refreshBtn.style.marginLeft = "8px";
		refreshBtn.onclick = () => void this.refreshProjectsList();

		const newProjectBtn = document.createElement("button");
		newProjectBtn.className = "learnharness-new-project-btn mod-cta";
		newProjectBtn.textContent = "+ New Project";
		newProjectBtn.style.marginLeft = "8px";
		newProjectBtn.onclick = () => void this.openNewProjectModal();

		projectControl.appendChild(select);
		projectControl.appendChild(refreshBtn);
		projectControl.appendChild(newProjectBtn);
		projectItem.appendChild(projectInfo);
		projectItem.appendChild(projectControl);
		container.appendChild(projectItem);

		// If projects not loaded yet, fetch in background
		if (this.projects.length === 0) {
			void this.refreshProjectsList();
		}
	}

	private renderSafetySection(container: HTMLElement): void {
		const sectionHeader = document.createElement("h3");
		sectionHeader.textContent = "Safety & Thresholds";
		container.appendChild(sectionHeader);

		const thresholdItem = document.createElement("div");
		thresholdItem.className = "setting-item learnharness-setting-item";

		const thresholdInfo = document.createElement("div");
		thresholdInfo.className = "setting-item-info";
		const thresholdName = document.createElement("div");
		thresholdName.className = "setting-item-name";
		thresholdName.textContent = "Large Folder Warning Threshold";
		const thresholdDesc = document.createElement("div");
		thresholdDesc.className = "setting-item-description";
		thresholdDesc.textContent =
			"Warn and prompt confirmation before studying folders containing more than this number of notes.";
		thresholdInfo.appendChild(thresholdName);
		thresholdInfo.appendChild(thresholdDesc);

		const thresholdControl = document.createElement("div");
		thresholdControl.className = "setting-item-control";

		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.step = "1";
		input.className = "learnharness-input learnharness-folder-threshold-input";
		input.value = String(this.plugin.settings.largeFolderThreshold ?? 50);

		const saveThreshold = () => {
			const parsed = parseInt(input.value, 10);
			this.plugin.settings.largeFolderThreshold = !isNaN(parsed) && parsed > 0 ? parsed : 50;
			void this.plugin.saveSettings();
		};
		input.onchange = saveThreshold;
		input.onblur = saveThreshold;

		thresholdControl.appendChild(input);
		thresholdItem.appendChild(thresholdInfo);
		thresholdItem.appendChild(thresholdControl);
		container.appendChild(thresholdItem);
	}

	public renderProjectDropdownOptions(): void {
		if (!this.projectSelectEl) {
			return;
		}

		const select = this.projectSelectEl;
		select.innerHTML = "";

		const defaultOpt = document.createElement("option");
		defaultOpt.value = "";
		defaultOpt.textContent = "(Use Server Active Project)";
		select.appendChild(defaultOpt);

		const currentId = this.plugin.settings.activeProjectId || "";

		for (const proj of this.projects) {
			const opt = document.createElement("option");
			opt.value = proj.id;
			opt.textContent = `${proj.name} (${proj.id})`;
			if (proj.id === currentId) {
				opt.selected = true;
			}
			select.appendChild(opt);
		}

		for (let i = 0; i < select.options.length; i++) {
			const opt = select.options[i];
			if (opt && opt.value === currentId) {
				opt.selected = true;
				try {
					select.selectedIndex = i;
				} catch {
					// linkedom compatibility
				}
				break;
			}
		}

		try {
			select.value = currentId;
		} catch {
			// linkedom getter-only compatibility
		}
	}

	public async testConnection(): Promise<BridgeHealthStatus> {
		this.updateConnectionStatus(null, "Testing...");
		try {
			const health = await this.plugin.transport.checkHealth({ timeoutMs: 5000 });
			const versionStr = health.version ? ` (v${health.version})` : "";
			this.updateConnectionStatus(
				health.ok,
				health.ok ? `Connected${versionStr}` : `Disconnected: ${health.error || "Unknown error"}`,
			);
			return health;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.updateConnectionStatus(false, `Disconnected: ${msg}`);
			return { ok: false, error: msg };
		}
	}

	public async registerVault(): Promise<VaultSummary | null> {
		this.updateVaultStatus(null, "Registering...");
		try {
			const vault = await ensureVaultRegistered(this.plugin);
			this.updateVaultStatus(true, `Registered (${vault.id})`);
			if (this.vaultIdDisplayEl) {
				this.vaultIdDisplayEl.textContent = `Vault ID: ${vault.id}`;
			}
			return vault;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.updateVaultStatus(false, `Error: ${msg}`);
			return null;
		}
	}

	public async refreshProjectsList(): Promise<ProjectSummary[]> {
		try {
			const res = await this.plugin.transport.listProjects({ timeoutMs: 5000 });
			this.projects = res.projects || [];
			this.renderProjectDropdownOptions();
			return this.projects;
		} catch (err) {
			this.plugin.showNotice("LearnHarness: Failed to fetch projects list.");
			return [];
		}
	}

	public openNewProjectModal(): Promise<ProjectSummary | null> {
		const modal = new NewProjectModal({
			onSubmit: async (name, desc) => {
				return this.plugin.transport.createProject(name, desc);
			},
			onSuccess: async (proj) => {
				this.plugin.settings.activeProjectId = proj.id;
				await this.plugin.saveSettings();
				if (this.plugin.settings.vaultId) {
					void this.plugin.transport
						.attachVaultToProject(proj.id, this.plugin.settings.vaultId)
						.catch(() => {});
				}
				await this.refreshProjectsList();
				this.plugin.showNotice(`LearnHarness: Created and selected project "${proj.name}".`);
			},
		});
		return modal.open();
	}

	public updateConnectionStatus(ok: boolean | null, text: string): void {
		if (!this.connectionStatusEl) return;
		this.connectionStatusEl.textContent = ok === true ? `● ${text}` : ok === false ? `○ ${text}` : `◌ ${text}`;
		if (ok === true) {
			this.connectionStatusEl.style.color = "var(--text-success, #5cb85c)";
		} else if (ok === false) {
			this.connectionStatusEl.style.color = "var(--text-error, #d9534f)";
		} else {
			this.connectionStatusEl.style.color = "var(--text-muted, #888888)";
		}
	}

	public updateVaultStatus(ok: boolean | null, text: string): void {
		if (!this.vaultStatusEl) return;
		this.vaultStatusEl.textContent = ok === true ? `● ${text}` : ok === false ? `○ ${text}` : `◌ ${text}`;
		if (ok === true) {
			this.vaultStatusEl.style.color = "var(--text-success, #5cb85c)";
		} else if (ok === false) {
			this.vaultStatusEl.style.color = "var(--text-error, #d9534f)";
		} else {
			this.vaultStatusEl.style.color = "var(--text-muted, #888888)";
		}
	}
}
