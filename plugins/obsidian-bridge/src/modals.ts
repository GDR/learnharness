/**
 * Modals and Dialogs for LearnHarness Obsidian Bridge Plugin.
 *
 * Implements:
 * 1. LargeFolderConfirmModal: Warns and confirms before studying large folders (>50 notes).
 * 2. AskQuestionModal: Interactive prompt modal to query LearnHarness with note context.
 */

import type { AskQuestionResponse } from "./types.ts";

export interface LargeFolderConfirmModalOptions {
	folderName: string;
	noteCount: number;
	onConfirm?: () => void;
	onCancel?: () => void;
}

export class LargeFolderConfirmModal {
	public folderName: string;
	public noteCount: number;
	public isOpen = false;
	public confirmed: boolean | null = null;
	public containerEl?: HTMLElement;
	private resolvePromise?: (value: boolean) => void;

	constructor(folderName: string, noteCount: number) {
		this.folderName = folderName;
		this.noteCount = noteCount;
	}

	public open(): Promise<boolean> {
		this.isOpen = true;
		if (typeof document !== "undefined") {
			this.render();
		}
		return new Promise<boolean>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	public close(): void {
		this.isOpen = false;
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.parentNode.removeChild(this.containerEl);
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

		const modal = document.createElement("div");
		modal.className = "modal learnharness-confirm-modal";

		const title = document.createElement("div");
		title.className = "modal-title";
		title.textContent = "LearnHarness: Large Folder Warning";

		const content = document.createElement("div");
		content.className = "modal-content";
		content.textContent = `Folder "${this.folderName}" contains ${this.noteCount} markdown notes. Analyzing a large folder may take a few moments. Do you want to proceed?`;

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
	customModalOrHandler?:
		| ((folderName: string, count: number) => Promise<boolean>)
		| LargeFolderConfirmModal,
): Promise<boolean> {
	if (typeof customModalOrHandler === "function") {
		return customModalOrHandler(folderName, noteCount);
	}
	if (customModalOrHandler && typeof customModalOrHandler.open === "function") {
		return customModalOrHandler.open();
	}
	const modal = new LargeFolderConfirmModal(folderName, noteCount);
	return modal.open();
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
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.parentNode.removeChild(this.containerEl);
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
				const errMessage = err instanceof Error ? err.message : String(err);
				this.lastError = errMessage;
				this.renderError(errMessage);
				throw err;
			}
		}

		this.isLoading = false;
		this.renderLoading(false);
		return "";
	}

	private render(): void {
		const backdrop = document.createElement("div");
		backdrop.className = "modal-container mod-dim learnharness-modal-backdrop";

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
			void this.submit(textarea.value);
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
