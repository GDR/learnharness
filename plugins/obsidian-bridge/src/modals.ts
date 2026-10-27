/**
 * Modals and Dialogs for LearnHarness Obsidian Bridge Plugin.
 *
 * Implements:
 * 1. LargeFolderConfirmModal: Warns and confirms before studying large folders (>50 notes).
 * 2. AskQuestionModal: Interactive prompt modal to query LearnHarness with note context.
 */

import type { AskQuestionResponse, ProjectSummary } from "./types.ts";

export interface LargeFolderConfirmModalOptions {
	folderName: string;
	noteCount: number;
	folderPath?: string;
	projectName?: string;
	onConfirm?: () => void;
	onCancel?: () => void;
}

export class LargeFolderConfirmModal {
	public folderName: string;
	public noteCount: number;
	public folderPath?: string;
	public projectName?: string;
	public isOpen = false;
	public confirmed: boolean | null = null;
	public containerEl?: HTMLElement;
	private resolvePromise?: (value: boolean) => void;
	private handleKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") {
			this.cancel();
		}
	};

	constructor(
		folderNameOrOptions: string | LargeFolderConfirmModalOptions,
		noteCount = 0,
		options?: Partial<LargeFolderConfirmModalOptions>,
	) {
		if (typeof folderNameOrOptions === "object" && folderNameOrOptions !== null) {
			this.folderName = folderNameOrOptions.folderName;
			this.noteCount = folderNameOrOptions.noteCount;
			this.folderPath = folderNameOrOptions.folderPath;
			this.projectName = folderNameOrOptions.projectName;
		} else {
			this.folderName = folderNameOrOptions;
			this.noteCount = noteCount;
			this.folderPath = options?.folderPath;
			this.projectName = options?.projectName;
		}
	}

	public open(): Promise<boolean> {
		this.isOpen = true;
		if (typeof document !== "undefined") {
			this.render();
			return new Promise<boolean>((resolve) => {
				this.resolvePromise = resolve;
			});
		}
		return new Promise<boolean>((resolve) => {
			this.resolvePromise = resolve;
			queueMicrotask(() => {
				if (this.isOpen && this.confirmed === null) {
					this.confirmed = true;
					this.isOpen = false;
					resolve(true);
				}
			});
		});
	}

	public close(): void {
		this.isOpen = false;
		if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
			window.removeEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
			document.removeEventListener("keydown", this.handleKeyDown);
		}
		if (this.containerEl) {
			if (
				this.containerEl.parentNode &&
				typeof this.containerEl.parentNode.removeChild === "function"
			) {
				this.containerEl.parentNode.removeChild(this.containerEl);
			} else if (typeof (this.containerEl as { remove?: () => void }).remove === "function") {
				(this.containerEl as { remove: () => void }).remove();
			}
		}
		if (this.confirmed === null) {
			this.confirmed = false;
			this.resolvePromise?.(false);
		}
	}

	public confirm(): void {
		this.confirmed = true;
		this.resolvePromise?.(true);
		this.close();
	}

	public cancel(): void {
		this.confirmed = false;
		this.resolvePromise?.(false);
		this.close();
	}

	private render(): void {
		const backdrop = document.createElement("div");
		backdrop.className = "modal-container mod-dim learnharness-modal-backdrop";
		backdrop.onclick = (evt: MouseEvent) => {
			if (evt.target === backdrop) {
				this.cancel();
			}
		};

		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
			document.addEventListener("keydown", this.handleKeyDown);
		}

		const modal = document.createElement("div");
		modal.className = "modal learnharness-confirm-modal";

		const title = document.createElement("div");
		title.className = "modal-title";
		title.textContent = "LearnHarness: Large Folder Warning";

		const content = document.createElement("div");
		content.className = "modal-content";

		const folderInfo = document.createElement("div");
		folderInfo.className = "learnharness-folder-info";
		folderInfo.textContent = `Folder: "${this.folderName}"${this.folderPath ? ` (${this.folderPath})` : ""}`;

		const countInfo = document.createElement("div");
		countInfo.className = "learnharness-count-info";
		countInfo.textContent = `Contains ${this.noteCount} markdown notes.`;

		if (this.projectName) {
			const projectInfo = document.createElement("div");
			projectInfo.className = "learnharness-project-info";
			projectInfo.textContent = `Target Project: ${this.projectName}`;
			content.appendChild(projectInfo);
		}

		const warningText = document.createElement("p");
		warningText.className = "learnharness-warning-text";
		warningText.textContent =
			"Analyzing a large folder will index and extract study evidence across all contained notes. This may take several minutes. Do you want to proceed?";

		content.appendChild(folderInfo);
		content.appendChild(countInfo);
		content.appendChild(warningText);

		const buttonContainer = document.createElement("div");
		buttonContainer.className = "modal-button-container";

		const cancelBtn = document.createElement("button");
		cancelBtn.className = "mod-cancel";
		cancelBtn.textContent = "Cancel";
		cancelBtn.onclick = () => this.cancel();

		const proceedBtn = document.createElement("button");
		proceedBtn.className = "mod-cta";
		proceedBtn.textContent = "Proceed";
		proceedBtn.onclick = () => this.confirm();

		buttonContainer.appendChild(cancelBtn);
		buttonContainer.appendChild(proceedBtn);

		modal.appendChild(title);
		modal.appendChild(content);
		modal.appendChild(buttonContainer);
		backdrop.appendChild(modal);

		document.body.appendChild(backdrop);
		this.containerEl = backdrop;
	}
}

export async function confirmLargeFolder(
	folderName: string,
	noteCount: number,
	customModalOrHandlerOrOptions?:
		| ((folderName: string, count: number) => Promise<boolean>)
		| LargeFolderConfirmModal
		| {
				folderPath?: string;
				projectName?: string;
				confirmHandler?: (folderName: string, count: number) => Promise<boolean>;
		  },
): Promise<boolean> {
	if (typeof customModalOrHandlerOrOptions === "function") {
		return customModalOrHandlerOrOptions(folderName, noteCount);
	}
	if (
		customModalOrHandlerOrOptions &&
		"confirmHandler" in customModalOrHandlerOrOptions &&
		typeof customModalOrHandlerOrOptions.confirmHandler === "function"
	) {
		return customModalOrHandlerOrOptions.confirmHandler(folderName, noteCount);
	}
	if (
		customModalOrHandlerOrOptions &&
		"open" in customModalOrHandlerOrOptions &&
		typeof (customModalOrHandlerOrOptions as LargeFolderConfirmModal).open === "function"
	) {
		return (customModalOrHandlerOrOptions as LargeFolderConfirmModal).open();
	}
	if (typeof document === "undefined") {
		return true;
	}
	const opts =
		typeof customModalOrHandlerOrOptions === "object" && customModalOrHandlerOrOptions !== null
			? customModalOrHandlerOrOptions
			: undefined;
	const modal = new LargeFolderConfirmModal(folderName, noteCount, opts);
	return modal.open();
}

export interface NewProjectModalOptions {
	onSubmit?: (
		name: string,
		description?: string,
	) => Promise<{ project: ProjectSummary } | ProjectSummary | unknown>;
	onSuccess?: (project: ProjectSummary) => void;
	onCancel?: () => void;
}

export class NewProjectModal {
	public isOpen = false;
	public containerEl?: HTMLElement;
	public nameInput?: HTMLInputElement;
	public descInput?: HTMLInputElement | HTMLTextAreaElement;
	public errorEl?: HTMLElement;
	public lastCreatedProject?: ProjectSummary;
	private onSubmit?: (
		name: string,
		description?: string,
	) => Promise<{ project: ProjectSummary } | ProjectSummary | unknown>;
	private onSuccess?: (project: ProjectSummary) => void;
	private onCancel?: () => void;
	private resolvePromise?: (project: ProjectSummary | null) => void;
	private handleKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") {
			this.cancel();
		}
	};

	constructor(
		options?:
			| NewProjectModalOptions
			| ((
					name: string,
					description?: string,
			  ) => Promise<{ project: ProjectSummary } | ProjectSummary | unknown>),
	) {
		if (typeof options === "function") {
			this.onSubmit = options;
		} else if (options) {
			this.onSubmit = options.onSubmit;
			this.onSuccess = options.onSuccess;
			this.onCancel = options.onCancel;
		}
	}

	public open(): Promise<ProjectSummary | null> {
		this.isOpen = true;
		if (typeof document !== "undefined") {
			this.render();
			return new Promise<ProjectSummary | null>((resolve) => {
				this.resolvePromise = resolve;
			});
		}
		return new Promise<ProjectSummary | null>((resolve) => {
			this.resolvePromise = resolve;
			queueMicrotask(() => {
				if (this.isOpen) {
					this.isOpen = false;
					resolve(null);
				}
			});
		});
	}

	public close(): void {
		this.isOpen = false;
		if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
			window.removeEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
			document.removeEventListener("keydown", this.handleKeyDown);
		}
		if (this.containerEl) {
			if (
				this.containerEl.parentNode &&
				typeof this.containerEl.parentNode.removeChild === "function"
			) {
				this.containerEl.parentNode.removeChild(this.containerEl);
			} else if (typeof (this.containerEl as { remove?: () => void }).remove === "function") {
				(this.containerEl as { remove: () => void }).remove();
			}
		}
		this.resolvePromise?.(this.lastCreatedProject ?? null);
	}

	public cancel(): void {
		this.onCancel?.();
		this.close();
	}

	public async submit(name: string, description?: string): Promise<ProjectSummary | null> {
		const trimmedName = name?.trim();
		if (!trimmedName) {
			const msg = "Project name cannot be empty";
			if (this.errorEl) {
				this.errorEl.textContent = msg;
				this.errorEl.style.display = "block";
			}
			return null;
		}

		try {
			let created: ProjectSummary | null = null;
			if (this.onSubmit) {
				const res = await this.onSubmit(trimmedName, description?.trim() || undefined);
				if (res && typeof res === "object" && "project" in res) {
					created = (res as { project: ProjectSummary }).project;
				} else {
					created = res as ProjectSummary;
				}
			} else {
				created = {
					id: `proj_${trimmedName.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}`,
					name: trimmedName,
					description: description?.trim() || undefined,
				};
			}

			this.lastCreatedProject = created;
			this.onSuccess?.(created);
			this.resolvePromise?.(created);
			this.close();
			return created;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (this.errorEl) {
				this.errorEl.textContent = msg;
				this.errorEl.style.display = "block";
			}
			throw err;
		}
	}

	private render(): void {
		const backdrop = document.createElement("div");
		backdrop.className = "modal-container mod-dim learnharness-modal-backdrop";
		backdrop.onclick = (evt: MouseEvent) => {
			if (evt.target === backdrop) {
				this.cancel();
			}
		};

		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
			document.addEventListener("keydown", this.handleKeyDown);
		}

		const modal = document.createElement("div");
		modal.className = "modal learnharness-new-project-modal";

		const title = document.createElement("div");
		title.className = "modal-title";
		title.textContent = "LearnHarness: Create New Project";

		const content = document.createElement("div");
		content.className = "modal-content";

		const nameLabel = document.createElement("label");
		nameLabel.className = "learnharness-label";
		nameLabel.textContent = "Project Name:";
		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.className = "learnharness-input project-name-input";
		nameInput.placeholder = "e.g. Neuroscience 101";
		this.nameInput = nameInput;

		const descLabel = document.createElement("label");
		descLabel.className = "learnharness-label";
		descLabel.textContent = "Description (optional):";
		const descInput = document.createElement("textarea");
		descInput.className = "learnharness-textarea project-desc-input";
		descInput.placeholder = "Optional description for this learning workspace";
		this.descInput = descInput;

		const errorEl = document.createElement("div");
		errorEl.className = "learnharness-error-message";
		errorEl.style.display = "none";
		errorEl.style.color = "var(--text-error, #d9534f)";
		this.errorEl = errorEl;

		content.appendChild(nameLabel);
		content.appendChild(nameInput);
		content.appendChild(descLabel);
		content.appendChild(descInput);
		content.appendChild(errorEl);

		const buttonContainer = document.createElement("div");
		buttonContainer.className = "modal-button-container";

		const cancelBtn = document.createElement("button");
		cancelBtn.className = "mod-cancel";
		cancelBtn.textContent = "Cancel";
		cancelBtn.onclick = () => this.cancel();

		const createBtn = document.createElement("button");
		createBtn.className = "mod-cta";
		createBtn.textContent = "Create Project";
		createBtn.onclick = async () => {
			createBtn.disabled = true;
			try {
				await this.submit(nameInput.value, descInput.value);
			} catch {
				createBtn.disabled = false;
			}
		};

		buttonContainer.appendChild(cancelBtn);
		buttonContainer.appendChild(createBtn);

		modal.appendChild(title);
		modal.appendChild(content);
		modal.appendChild(buttonContainer);
		backdrop.appendChild(modal);

		document.body.appendChild(backdrop);
		this.containerEl = backdrop;

		setTimeout(() => nameInput.focus?.(), 50);
	}
}

export interface AskQuestionModalContext {
	filePath?: string;
	selection?: string;
}

export interface AskQuestionSubmitHandler {
	(question: string, context?: AskQuestionModalContext): Promise<string | AskQuestionResponse>;
}

export class AskQuestionModal {
	public context?: AskQuestionModalContext;
	public onSubmit?: AskQuestionSubmitHandler;
	public isOpen = false;
	public lastQuestion = "";
	public lastAnswer = "";
	public lastError = "";
	public isLoading = false;
	public containerEl?: HTMLElement;
	private answerEl?: HTMLElement;
	private statusEl?: HTMLElement;
	private resolvePromise?: (value: string | null) => void;
	private handleKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") {
			this.close();
		}
	};

	constructor(context?: AskQuestionModalContext, onSubmit?: AskQuestionSubmitHandler) {
		this.context = context;
		this.onSubmit = onSubmit;
	}

	public open(): Promise<string | null> {
		this.isOpen = true;
		if (typeof document !== "undefined") {
			this.render();
		}
		return new Promise<string | null>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	public close(): void {
		this.isOpen = false;
		if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
			window.removeEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
			document.removeEventListener("keydown", this.handleKeyDown);
		}
		if (this.containerEl) {
			if (
				this.containerEl.parentNode &&
				typeof this.containerEl.parentNode.removeChild === "function"
			) {
				this.containerEl.parentNode.removeChild(this.containerEl);
			} else if (typeof (this.containerEl as { remove?: () => void }).remove === "function") {
				(this.containerEl as { remove: () => void }).remove();
			}
		}
		if (this.resolvePromise) {
			this.resolvePromise(this.lastAnswer || null);
		}
	}

	public async submit(question: string): Promise<string> {
		const trimmed = question.trim();
		if (!trimmed) {
			this.renderError("Question cannot be empty.");
			return "";
		}

		this.lastQuestion = trimmed;
		this.isLoading = true;
		this.lastError = "";
		this.renderLoading(true);

		if (this.onSubmit) {
			try {
				const response = await this.onSubmit(trimmed, this.context);
				const answerText = typeof response === "string" ? response : response.answer;
				this.lastAnswer = answerText;
				this.isLoading = false;
				this.renderLoading(false);
				this.renderAnswer(answerText);
				this.resolvePromise?.(answerText);
				return answerText;
			} catch (err) {
				this.isLoading = false;
				this.renderLoading(false);
				let errMessage = err instanceof Error ? err.message : String(err);
				if (/connection refused|econnrefused/i.test(errMessage)) {
					errMessage = "LearnHarness is offline or unreachable. Please start LearnHarness.";
				} else if (/timed out|etimedout/i.test(errMessage)) {
					errMessage = "Request timed out while contacting LearnHarness.";
				}
				this.lastError = errMessage;
				this.renderError(errMessage);
				return "";
			}
		}

		this.isLoading = false;
		this.renderLoading(false);
		return "";
	}

	private render(): void {
		const backdrop = document.createElement("div");
		backdrop.className = "modal-container mod-dim learnharness-modal-backdrop";
		backdrop.onclick = (evt: MouseEvent) => {
			if (evt.target === backdrop) {
				this.close();
			}
		};

		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("keydown", this.handleKeyDown);
		} else if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
			document.addEventListener("keydown", this.handleKeyDown);
		}

		const modal = document.createElement("div");
		modal.className = "modal learnharness-ask-modal";

		const title = document.createElement("div");
		title.className = "modal-title";
		title.textContent = "Ask LearnHarness";

		const content = document.createElement("div");
		content.className = "modal-content";

		// Note Context Badge
		if (this.context?.filePath) {
			const badge = document.createElement("div");
			badge.className = "learnharness-context-badge";
			badge.textContent = `Context: ${this.context.filePath}`;
			content.appendChild(badge);
		}

		// Selection Preview
		if (this.context?.selection) {
			const preview = document.createElement("blockquote");
			preview.className = "learnharness-selection-preview";
			preview.textContent =
				this.context.selection.length > 200
					? `${this.context.selection.slice(0, 197)}...`
					: this.context.selection;
			content.appendChild(preview);
		}

		const textarea = document.createElement("textarea");
		textarea.className = "learnharness-question-input";
		textarea.placeholder = "Ask a question about this note or selection...";
		textarea.rows = 4;
		content.appendChild(textarea);

		const statusEl = document.createElement("div");
		statusEl.className = "learnharness-modal-status";
		this.statusEl = statusEl;
		content.appendChild(statusEl);

		const answerEl = document.createElement("div");
		answerEl.className = "learnharness-modal-answer";
		this.answerEl = answerEl;
		content.appendChild(answerEl);

		const buttonContainer = document.createElement("div");
		buttonContainer.className = "modal-button-container";

		const closeBtn = document.createElement("button");
		closeBtn.className = "mod-cancel";
		closeBtn.textContent = "Close";
		closeBtn.onclick = () => this.close();

		const askBtn = document.createElement("button");
		askBtn.className = "mod-cta";
		askBtn.textContent = "Ask";
		askBtn.onclick = () => {
			void this.submit(textarea.value).catch(() => {});
		};

		buttonContainer.appendChild(closeBtn);
		buttonContainer.appendChild(askBtn);

		modal.appendChild(title);
		modal.appendChild(content);
		modal.appendChild(buttonContainer);
		backdrop.appendChild(modal);

		document.body.appendChild(backdrop);
		this.containerEl = backdrop;
	}

	private renderLoading(loading: boolean): void {
		if (this.statusEl) {
			this.statusEl.textContent = loading ? "Thinking..." : "";
		}
	}

	private renderAnswer(answer: string): void {
		if (this.answerEl) {
			this.answerEl.textContent = answer;
			this.answerEl.style.display = "block";
		}
	}

	private renderError(errorMsg: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = `Error: ${errorMsg}`;
			this.statusEl.style.color = "var(--text-error, #e53935)";
		}
	}
}
