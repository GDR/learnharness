/**
 * Comprehensive Unit and Integration Tests for LearnHarness Obsidian Bridge Contextual Commands.
 *
 * Verifies Milestone E Slice 2 (F31 / PR E.2):
 * - Mock Obsidian API test harness (MockTFile, MockTFolder, MockEditor, MockMarkdownView, MockVault, MockWorkspace, MockApp, MockMenu).
 * - Contextual study commands:
 *   - "Study current note": reads active note, posts to /study-sessions.
 *   - "Study selection": reads active editor selection, posts to /study-sessions.
 *   - "Study folder": recursive markdown note collection, >50 notes confirmation dialog, posts to /study-sessions.
 *   - "Ask LearnHarness": direct / interactive query prompt with note context to /ask.
 * - Command palette registration & checkCallback conditions.
 * - Workspace context menus (file-menu for folder/note and editor-menu for selection).
 * - Modals: LargeFolderConfirmModal and AskQuestionModal lifecycle and interactions.
 * - Graceful offline error handling: non-intrusive Obsidian Notices on ECONNREFUSED, ETIMEDOUT, 401, 403, 404.
 * - Missing activeProjectId configuration prompting Notice.
 * - Teardown and lifecycle cleanup on onunload.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";

import { LearnHarnessBridgePlugin } from "../plugins/obsidian-bridge/src/main.ts";
import {
	executeStudyCurrentNote,
	executeStudySelection,
	executeStudyFolder,
	executeAskLearnHarness,
	collectMarkdownFiles,
	handleBridgeError,
} from "../plugins/obsidian-bridge/src/commands.ts";
import {
	LargeFolderConfirmModal,
	AskQuestionModal,
	confirmLargeFolder,
} from "../plugins/obsidian-bridge/src/modals.ts";
import { BridgeTransportError } from "../plugins/obsidian-bridge/src/transport.ts";
import { BridgeClient } from "../plugins/obsidian-bridge/src/client.ts";
import type {
	ObsidianAbstractFile,
	ObsidianEditor,
	ObsidianEventRef,
	ObsidianMarkdownView,
	ObsidianMenu,
	ObsidianMenuItem,
	ObsidianTFile,
	ObsidianTFolder,
	ObsidianVault,
	ObsidianWorkspace,
	ObsidianApp,
} from "../plugins/obsidian-bridge/src/types.ts";

/* -------------------------------------------------------------------------- */
/*                         Mock Obsidian API Test Harness                     */
/* -------------------------------------------------------------------------- */

export class MockTFile implements ObsidianTFile {
	path: string;
	name: string;
	extension: string;
	basename: string;
	content: string;

	constructor(filePath: string, content = "") {
		this.path = filePath;
		this.name = filePath.split("/").pop() ?? filePath;
		const dotIdx = this.name.lastIndexOf(".");
		this.extension = dotIdx >= 0 ? this.name.slice(dotIdx + 1) : "";
		this.basename = dotIdx >= 0 ? this.name.slice(0, dotIdx) : this.name;
		this.content = content;
	}
}

export class MockTFolder implements ObsidianTFolder {
	path: string;
	name: string;
	children: ObsidianAbstractFile[];

	constructor(folderPath: string, children: ObsidianAbstractFile[] = []) {
		this.path = folderPath;
		this.name = folderPath.replace(/\/$/, "").split("/").pop() ?? folderPath;
		this.children = children;
	}
}

export class MockEditor implements ObsidianEditor {
	private value: string;
	private selection: string;

	constructor(value = "", selection = "") {
		this.value = value;
		this.selection = selection;
	}

	getValue(): string {
		return this.value;
	}

	getSelection(): string {
		return this.selection;
	}

	setValue(val: string): void {
		this.value = val;
	}

	setSelection(sel: string): void {
		this.selection = sel;
	}
}

export class MockMarkdownView implements ObsidianMarkdownView {
	file: ObsidianTFile | null;
	editor: MockEditor;

	constructor(file: ObsidianTFile | null, editor: MockEditor) {
		this.file = file;
		this.editor = editor;
	}
}

export class MockVault implements ObsidianVault {
	public name: string;
	private files = new Map<string, MockTFile>();

	constructor(name = "TestVault") {
		this.name = name;
	}

	getName(): string {
		return this.name;
	}

	async read(file: ObsidianTFile): Promise<string> {
		const f = this.files.get(file.path);
		return f ? f.content : (file as MockTFile).content ?? "";
	}

	addFile(file: MockTFile): void {
		this.files.set(file.path, file);
	}
}

export class MockMenuItem implements ObsidianMenuItem {
	public title = "";
	public icon = "";
	public clickHandler?: (evt: MouseEvent | KeyboardEvent) => unknown;

	setTitle(title: string): this {
		this.title = title;
		return this;
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown): this {
		this.clickHandler = cb;
		return this;
	}

	triggerClick(): unknown {
		return this.clickHandler?.({ type: "click" } as unknown as MouseEvent);
	}
}

export class MockMenu implements ObsidianMenu {
	public items: MockMenuItem[] = [];

	addItem(cb: (item: ObsidianMenuItem) => unknown): this {
		const item = new MockMenuItem();
		cb(item);
		this.items.push(item);
		return this;
	}
}

export class MockWorkspace implements ObsidianWorkspace {
	public activeFile: ObsidianTFile | null = null;
	public activeView: ObsidianMarkdownView | null = null;
	public listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
	public removedRefs: ObsidianEventRef[] = [];

	getActiveFile(): ObsidianTFile | null {
		return this.activeFile;
	}

	getActiveViewOfType<T>(): T | null {
		return this.activeView as unknown as T;
	}

	on(name: "file-menu", callback: (menu: ObsidianMenu, file: ObsidianAbstractFile, source?: string) => unknown): ObsidianEventRef;
	on(name: "editor-menu", callback: (menu: ObsidianMenu, editor: ObsidianEditor, view: ObsidianMarkdownView) => unknown): ObsidianEventRef;
	on(name: string, callback: (...args: any[]) => unknown): ObsidianEventRef;
	on(name: string, callback: (...args: any[]) => unknown): ObsidianEventRef {
		if (!this.listeners.has(name)) {
			this.listeners.set(name, []);
		}
		this.listeners.get(name)!.push(callback);
		return { id: `${name}_ref_${Math.random().toString(36).slice(2)}` };
	}

	offref(ref: ObsidianEventRef): void {
		this.removedRefs.push(ref);
	}

	trigger(name: string, ...args: unknown[]): void {
		const list = this.listeners.get(name) ?? [];
		for (const cb of list) {
			cb(...args);
		}
	}
}

export class MockApp implements ObsidianApp {
	public vault: MockVault;
	public workspace: MockWorkspace;

	constructor(vaultName = "ResearchVault") {
		this.vault = new MockVault(vaultName);
		this.workspace = new MockWorkspace();
	}
}

/* -------------------------------------------------------------------------- */
/*                                Test Suites                                 */
/* -------------------------------------------------------------------------- */

describe("Obsidian Bridge Client Alias", () => {
	it("BridgeClient is exported and instantiable with settings", () => {
		const client = new BridgeClient({
			serverUrl: "http://127.0.0.1:3000",
			activeProjectId: "proj_test_01",
		});
		assert.equal(client.getSettings().activeProjectId, "proj_test_01");
		assert.equal(typeof client.postStudyFolder, "function");
	});
});

describe("Contextual Commands Suite", () => {
	let server: http.Server;
	let serverPort = 0;
	let lastRequestUrl: string | undefined;
	let lastRequestBody: Record<string, unknown> | null = null;
	let lastRequestMethod: string | undefined;
	let serverStatusHandler: (req: http.IncomingMessage, res: http.ServerResponse) => boolean =
		() => false;

	before(async () => {
		server = http.createServer((req, res) => {
			lastRequestUrl = req.url;
			lastRequestMethod = req.method;

			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});

			req.on("end", () => {
				try {
					lastRequestBody = body ? (JSON.parse(body) as Record<string, unknown>) : null;
				} catch {
					lastRequestBody = null;
				}

				if (serverStatusHandler(req, res)) {
					return;
				}

				if (req.url?.includes("/study-sessions") && req.method === "POST") {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ sessionId: "sess_created_987" }));
					return;
				}

				if (req.url?.includes("/ask") && req.method === "POST") {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(
						JSON.stringify({ answer: "Calculated answer for contextual query." }),
					);
					return;
				}

				res.statusCode = 404;
				res.end(JSON.stringify({ error: "Endpoint not found" }));
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				serverPort = addr.port;
				resolve();
			});
		});
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function createTestPlugin(app?: MockApp): LearnHarnessBridgePlugin {
		const mockApp = app ?? new MockApp("NeuroscienceVault");
		const plugin = new LearnHarnessBridgePlugin(mockApp);
		plugin.settings = {
			serverUrl: `http://127.0.0.1:${serverPort}`,
			activeProjectId: "proj_neuro_42",
			vaultId: "vault_neuro_01",
		};
		plugin.transport.updateSettings(plugin.settings);
		return plugin;
	}

	/* ---------------------------------------------------------------------- */
	/* 1. Command Registration & checkCallback                                */
	/* ---------------------------------------------------------------------- */
	describe("Command Palette Registrations & checkCallback", () => {
		it("registers contextual commands upon onload", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			assert.ok(plugin.commands.has("learnharness:study-current-note"));
			assert.ok(plugin.commands.has("learnharness:study-selection"));
			assert.ok(plugin.commands.has("learnharness:ask-learnharness"));
			assert.ok(plugin.commands.has("learnharness:ask-about-selection"));
		});

		it("study-current-note checkCallback returns true only when active file is markdown", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			const cmd = plugin.commands.get("learnharness:study-current-note")!;
			assert.ok(cmd.checkCallback);

			// Case A: No active file
			app.workspace.activeFile = null;
			assert.equal(cmd.checkCallback(true), false);

			// Case B: Non-markdown file
			app.workspace.activeFile = new MockTFile("diagram.png");
			assert.equal(cmd.checkCallback(true), false);

			// Case C: Markdown file
			app.workspace.activeFile = new MockTFile("Notes/Synapses.md", "# Synapses");
			assert.equal(cmd.checkCallback(true), true);
		});

		it("study-selection checkCallback returns true when note view is active even without selection", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			const cmd = plugin.commands.get("learnharness:study-selection")!;
			assert.ok(cmd.checkCallback);

			// Case A: No active view and no active file
			app.workspace.activeView = null;
			app.workspace.activeFile = null;
			assert.equal(cmd.checkCallback(true), false);

			// Case B: Active view with empty selection (accessible via note fallback)
			const editor = new MockEditor("All note text", "");
			app.workspace.activeView = new MockMarkdownView(new MockTFile("Test.md"), editor);
			assert.equal(cmd.checkCallback(true), true);

			// Case C: Active view with non-empty selection
			editor.setSelection("selected passage");
			assert.equal(cmd.checkCallback(true), true);
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 2. Study Current Note Command                                          */
	/* ---------------------------------------------------------------------- */
	describe("Study Current Note Command", () => {
		it("successfully reads active note and starts study session", async () => {
			const app = new MockApp("NeuroscienceVault");
			const noteFile = new MockTFile("Topics/ActionPotential.md", "# Action Potential\nDepolarization details.");
			app.vault.addFile(noteFile);
			app.workspace.activeFile = noteFile;

			const plugin = createTestPlugin(app);

			const result = await executeStudyCurrentNote(plugin);
			assert.ok(result);
			assert.equal(result.sessionId, "sess_created_987");

			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/study-sessions");
			assert.equal(lastRequestMethod, "POST");
			assert.deepEqual(lastRequestBody, {
				vaultName: "NeuroscienceVault",
				filePath: "Topics/ActionPotential.md",
				content: "# Action Potential\nDepolarization details.",
				vaultId: "vault_neuro_01",
			});

			assert.equal(
				plugin.lastNotice,
				'LearnHarness: Started study session for "ActionPotential"',
			);
		});

		it("shows notice and halts when no active file is open", async () => {
			const app = new MockApp();
			app.workspace.activeFile = null;
			const plugin = createTestPlugin(app);

			lastRequestBody = null;
			const result = await executeStudyCurrentNote(plugin);
			assert.equal(result, null);
			assert.equal(lastRequestBody, null);
			assert.equal(plugin.lastNotice, "LearnHarness: No active markdown note open.");
		});

		it("shows notice when active file is not a markdown file", async () => {
			const app = new MockApp();
			app.workspace.activeFile = new MockTFile("Assets/brain.svg");
			const plugin = createTestPlugin(app);

			lastRequestBody = null;
			const result = await executeStudyCurrentNote(plugin);
			assert.equal(result, null);
			assert.equal(lastRequestBody, null);
			assert.equal(plugin.lastNotice, "LearnHarness: Active file is not a markdown note.");
		});

		it("handles empty note content cleanly", async () => {
			const app = new MockApp();
			const noteFile = new MockTFile("Empty.md", "");
			app.vault.addFile(noteFile);
			app.workspace.activeFile = noteFile;

			const plugin = createTestPlugin(app);
			const result = await executeStudyCurrentNote(plugin);
			assert.ok(result);
			assert.equal(lastRequestBody?.content, "");
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 3. Study Selection Command                                             */
	/* ---------------------------------------------------------------------- */
	describe("Study Selection Command", () => {
		it("reads selection and note context, sending payload to study-sessions", async () => {
			const app = new MockApp("NeuroscienceVault");
			const noteFile = new MockTFile("Axons.md", "Full text of axons note with specific paragraph.");
			app.vault.addFile(noteFile);
			const editor = new MockEditor(noteFile.content, "specific paragraph");
			const view = new MockMarkdownView(noteFile, editor);
			app.workspace.activeView = view;
			app.workspace.activeFile = noteFile;

			const plugin = createTestPlugin(app);

			const result = await executeStudySelection(plugin, editor, view);
			assert.ok(result);
			assert.equal(result.sessionId, "sess_created_987");

			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/study-sessions");
			assert.equal(lastRequestBody?.selection, "specific paragraph");
			assert.equal(lastRequestBody?.filePath, "Axons.md");
			assert.equal(lastRequestBody?.vaultName, "NeuroscienceVault");
			assert.equal(plugin.lastNotice, "LearnHarness: Started study session for selected text");
		});

		it("falls back to studying active note when selection is empty or whitespace", async () => {
			const app = new MockApp("NeuroscienceVault");
			const noteFile = new MockTFile("Test.md", "Full content of test note.");
			app.vault.addFile(noteFile);
			const editor = new MockEditor(noteFile.content, "   ");
			const view = new MockMarkdownView(noteFile, editor);
			app.workspace.activeView = view;
			app.workspace.activeFile = noteFile;

			const plugin = createTestPlugin(app);
			lastRequestBody = null;

			const result = await executeStudySelection(plugin, editor, view);
			assert.ok(result);
			assert.equal(result.sessionId, "sess_created_987");
			const requestBody = lastRequestBody as Record<string, unknown> | null;
			assert.equal(requestBody?.filePath, "Test.md");
			assert.equal(requestBody?.selection, undefined);
			assert.ok(
				plugin.notices.includes("LearnHarness: No selection found — studying current note"),
			);
			assert.equal(plugin.lastNotice, 'LearnHarness: Started study session for "Test"');
		});

		it("shows notice when no editor and no active file is found", async () => {
			const app = new MockApp();
			app.workspace.activeView = null;
			app.workspace.activeFile = null;
			const plugin = createTestPlugin(app);

			const result = await executeStudySelection(plugin);
			assert.equal(result, null);
			assert.equal(plugin.lastNotice, "LearnHarness: No active editor found.");
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 4. Study Folder Command & Markdown Collection                          */
	/* ---------------------------------------------------------------------- */
	describe("Study Folder Command & Markdown Collection", () => {
		it("collectMarkdownFiles recursively collects all and only .md files", () => {
			const subFolder = new MockTFolder("Vault/Topics/Sub", [
				new MockTFile("Vault/Topics/Sub/NoteC.md"),
				new MockTFile("Vault/Topics/Sub/image.jpg"),
			]);
			const rootFolder = new MockTFolder("Vault/Topics", [
				new MockTFile("Vault/Topics/NoteA.md"),
				new MockTFile("Vault/Topics/NoteB.MD"),
				new MockTFile("Vault/Topics/data.csv"),
				subFolder,
			]);

			const files = collectMarkdownFiles(rootFolder);
			assert.deepEqual(files.sort(), [
				"Vault/Topics/NoteA.md",
				"Vault/Topics/NoteB.MD",
				"Vault/Topics/Sub/NoteC.md",
			]);
		});

		it("studies normal folder (<= 50 notes) without prompt", async () => {
			const folder = new MockTFolder("Vault/Cognition", [
				new MockTFile("Vault/Cognition/Memory.md"),
				new MockTFile("Vault/Cognition/Attention.md"),
				new MockTFile("Vault/Cognition/Perception.md"),
			]);

			const plugin = createTestPlugin();
			let confirmCalled = false;
			const mockConfirm = async () => {
				confirmCalled = true;
				return true;
			};

			const result = await executeStudyFolder(plugin, folder, mockConfirm);
			assert.ok(result);
			assert.equal(confirmCalled, false, "Should not prompt when note count <= 50");

			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/study-sessions");
			assert.deepEqual(lastRequestBody, {
				vaultName: "NeuroscienceVault",
				folderPath: "Vault/Cognition",
				noteCount: 3,
				filePaths: [
					"Vault/Cognition/Memory.md",
					"Vault/Cognition/Attention.md",
					"Vault/Cognition/Perception.md",
				],
				vaultId: "vault_neuro_01",
				scopeType: "folder",
			});

			assert.equal(
				plugin.lastNotice,
				'LearnHarness: Started study session for folder "Cognition" (3 notes)',
			);
		});

		it("shows notice if folder contains 0 markdown files", async () => {
			const emptyFolder = new MockTFolder("Vault/EmptyDir", [
				new MockTFile("Vault/EmptyDir/file.pdf"),
			]);
			const plugin = createTestPlugin();
			lastRequestBody = null;

			const result = await executeStudyFolder(plugin, emptyFolder);
			assert.equal(result, null);
			assert.equal(lastRequestBody, null);
			assert.equal(
				plugin.lastNotice,
				'LearnHarness: Folder "EmptyDir" contains no markdown notes.',
			);
		});

		it("warns on large folder (>50 notes) and proceeds if user confirms", async () => {
			const largeChildren: MockTFile[] = [];
			for (let i = 1; i <= 55; i++) {
				largeChildren.push(new MockTFile(`Vault/Large/Note_${i}.md`));
			}
			const largeFolder = new MockTFolder("Vault/Large", largeChildren);

			const plugin = createTestPlugin();
			let confirmedCount = 0;
			const confirmHandler = async (_name: string, count: number) => {
				confirmedCount = count;
				return true;
			};

			const result = await executeStudyFolder(plugin, largeFolder, confirmHandler);
			assert.ok(result);
			assert.equal(confirmedCount, 55);
			assert.equal(lastRequestBody?.noteCount, 55);
			assert.equal(
				plugin.lastNotice,
				'LearnHarness: Started study session for folder "Large" (55 notes)',
			);
		});

		it("warns on large folder (>50 notes) and aborts if user cancels", async () => {
			const largeChildren: MockTFile[] = [];
			for (let i = 1; i <= 52; i++) {
				largeChildren.push(new MockTFile(`Vault/Large/Note_${i}.md`));
			}
			const largeFolder = new MockTFolder("Vault/Large", largeChildren);

			const plugin = createTestPlugin();
			const confirmHandler = async () => false;

			lastRequestBody = null;
			const result = await executeStudyFolder(plugin, largeFolder, confirmHandler);
			assert.equal(result, null);
			assert.equal(lastRequestBody, null, "Should not dispatch when user cancels");
			assert.equal(plugin.lastNotice, "LearnHarness: Folder study cancelled.");
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 5. Ask LearnHarness & Modals Suite                                     */
	/* ---------------------------------------------------------------------- */
	describe("Ask LearnHarness & Modals Suite", () => {
		it("submits direct question with context and displays answer", async () => {
			const app = new MockApp("NeuroscienceVault");
			const note = new MockTFile("Cerebellum.md", "Notes on motor control.");
			app.workspace.activeFile = note;
			const editor = new MockEditor(note.content, "motor control");
			app.workspace.activeView = new MockMarkdownView(note, editor);

			const plugin = createTestPlugin(app);

			const result = await executeAskLearnHarness(plugin, {
				editor,
				view: app.workspace.activeView,
				question: "How does the cerebellum coordinate motor timing?",
			});

			assert.ok(result);
			assert.equal(result.answer, "Calculated answer for contextual query.");
			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/ask");
			assert.deepEqual(lastRequestBody, {
				question: "How does the cerebellum coordinate motor timing?",
				context: {
					filePath: "Cerebellum.md",
					selection: "motor control",
				},
				vaultId: "vault_neuro_01",
			});
			assert.equal(
				plugin.lastNotice,
				"LearnHarness Answer: Calculated answer for contextual query.",
			);
		});

		it("rejects empty or whitespace-only direct question", async () => {
			const plugin = createTestPlugin();
			lastRequestBody = null;

			const result = await executeAskLearnHarness(plugin, { question: "   " });
			assert.equal(result, null);
			assert.equal(lastRequestBody, null);
			assert.equal(plugin.lastNotice, "LearnHarness: Question cannot be empty.");
		});

		it("LargeFolderConfirmModal confirm and cancel methods", async () => {
			const modal1 = new LargeFolderConfirmModal("BigFolder", 120);
			const promise1 = modal1.open();
			assert.equal(modal1.isOpen, true);
			modal1.confirm();
			const res1 = await promise1;
			assert.equal(res1, true);
			assert.equal(modal1.isOpen, false);

			const modal2 = new LargeFolderConfirmModal("BigFolder", 120);
			const promise2 = modal2.open();
			modal2.cancel();
			const res2 = await promise2;
			assert.equal(res2, false);

			// confirmLargeFolder helper
			const res3 = await confirmLargeFolder("Test", 60, async () => true);
			assert.equal(res3, true);
		});

		it("AskQuestionModal submit handles submission and updates answer state", async () => {
			let capturedQuestion = "";
			let capturedContext: unknown;
			const modal = new AskQuestionModal(
				{ filePath: "Reflexes.md", selection: "patellar reflex" },
				async (q, ctx) => {
					capturedQuestion = q;
					capturedContext = ctx;
					return { answer: "Monosynaptic spinal reflex arc." };
				},
			);

			const answer = await modal.submit("Explain the patellar reflex arc");
			assert.equal(answer, "Monosynaptic spinal reflex arc.");
			assert.equal(capturedQuestion, "Explain the patellar reflex arc");
			assert.deepEqual(capturedContext, {
				filePath: "Reflexes.md",
				selection: "patellar reflex",
			});
			assert.equal(modal.lastAnswer, "Monosynaptic spinal reflex arc.");
		});

		it("confirmLargeFolder safe headless fallback resolves cleanly without hanging", async () => {
			const res = await confirmLargeFolder("LargeTopic", 75);
			assert.equal(res, true);
		});

		it("LargeFolderConfirmModal.open() resolves true via fallback in headless environment", async () => {
			const modal = new LargeFolderConfirmModal("LargeTopic", 80);
			const res = await modal.open();
			assert.equal(res, true);
			assert.equal(modal.isOpen, false);
		});

		it("AskQuestionModal submit handles submission failure cleanly without unhandled rejection", async () => {
			const modal = new AskQuestionModal(
				{ filePath: "Reflexes.md" },
				async () => {
					throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
				},
			);

			const answer = await modal.submit("Why did it fail?");
			assert.equal(answer, "");
			assert.equal(
				modal.lastError,
				"LearnHarness is offline or unreachable. Please start LearnHarness.",
			);
			assert.equal(modal.isLoading, false);
		});

		it("modals dismiss on backdrop click and Escape key", async () => {
			const eventListeners: Record<string, ((e: unknown) => void)[]> = {};
			const mockWindow = {
				addEventListener: (event: string, cb: (e: unknown) => void) => {
					eventListeners[event] = eventListeners[event] || [];
					eventListeners[event].push(cb);
				},
				removeEventListener: (event: string, cb: (e: unknown) => void) => {
					if (eventListeners[event]) {
						eventListeners[event] = eventListeners[event].filter((f) => f !== cb);
					}
				},
			};

			const createdElements: Array<{
				className: string;
				onclick?: (e: unknown) => void;
				parentNode?: unknown;
			}> = [];
			const mockBody = {
				appendChild: (child: unknown) => {
					(child as { parentNode?: unknown }).parentNode = mockBody;
				},
				removeChild: (_child: unknown) => {},
			};

			const mockDocument = {
				createElement: (tag: string) => {
					const el = {
						tag,
						className: "",
						textContent: "",
						style: {} as Record<string, string>,
						parentNode: null as unknown,
						onclick: undefined as ((e: unknown) => void) | undefined,
						appendChild: () => {},
					};
					createdElements.push(el);
					return el;
				},
				body: mockBody,
			};

			const prevDoc = (globalThis as unknown as { document?: unknown }).document;
			const prevWin = (globalThis as unknown as { window?: unknown }).window;
			(globalThis as unknown as { document: unknown }).document = mockDocument;
			(globalThis as unknown as { window: unknown }).window = mockWindow;

			try {
				// 1. LargeFolderConfirmModal backdrop click dismiss
				const confirmModal = new LargeFolderConfirmModal("BigFolder", 100);
				const confirmPromise = confirmModal.open();
				assert.equal(confirmModal.isOpen, true);

				const backdropEl = createdElements.find((el) =>
					el.className.includes("learnharness-modal-backdrop"),
				);
				assert.ok(backdropEl?.onclick);
				// Click backdrop
				backdropEl.onclick({ target: backdropEl });
				const confirmRes = await confirmPromise;
				assert.equal(confirmRes, false);
				assert.equal(confirmModal.isOpen, false);

				// 2. AskQuestionModal Escape key dismiss
				const askModal = new AskQuestionModal({ filePath: "Test.md" });
				const askPromise = askModal.open();
				assert.equal(askModal.isOpen, true);

				// Fire Escape keydown
				const keydownListeners = eventListeners["keydown"] || [];
				for (const listener of keydownListeners) {
					listener({ key: "Escape" });
				}
				const askRes = await askPromise;
				assert.equal(askRes, null);
				assert.equal(askModal.isOpen, false);
			} finally {
				(globalThis as unknown as { document: unknown }).document = prevDoc;
				(globalThis as unknown as { window: unknown }).window = prevWin;
			}
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 6. Context Menus (File Menu and Editor Menu)                           */
	/* ---------------------------------------------------------------------- */
	describe("Context Menus (File Menu & Editor Menu)", () => {
		it("file-menu on folder adds 'LearnHarness: Study folder' and triggers action", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			const menu = new MockMenu();
			const testFolder = new MockTFolder("Vault/Psychology", [
				new MockTFile("Vault/Psychology/Conditioning.md"),
			]);

			app.workspace.trigger("file-menu", menu, testFolder);

			assert.equal(menu.items.length, 1);
			const item = menu.items[0];
			assert.ok(item);
			assert.equal(item.title, "LearnHarness: Study folder");

			// Trigger click
			await item.triggerClick();

			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/study-sessions");
			assert.equal(lastRequestBody?.folderPath, "Vault/Psychology");
		});

		it("file-menu on note adds 'LearnHarness: Study note' and triggers action", async () => {
			const app = new MockApp("NeuroscienceVault");
			const noteFile = new MockTFile("Vault/Dopamine.md", "# Dopamine pathways");
			app.vault.addFile(noteFile);

			const plugin = createTestPlugin(app);
			await plugin.onload();

			const menu = new MockMenu();
			app.workspace.trigger("file-menu", menu, noteFile);

			assert.equal(menu.items.length, 1);
			const item = menu.items[0];
			assert.ok(item);
			assert.equal(item.title, "LearnHarness: Study note");

			await item.triggerClick();

			assert.equal(lastRequestUrl, "/api/projects/proj_neuro_42/study-sessions");
			assert.equal(lastRequestBody?.filePath, "Vault/Dopamine.md");
		});

		it("editor-menu with selection adds study selection and ask options", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			const menu = new MockMenu();
			const editor = new MockEditor("Note content here", "selected phrase");
			const view = new MockMarkdownView(new MockTFile("Note.md"), editor);

			app.workspace.trigger("editor-menu", menu, editor, view);

			assert.equal(menu.items.length, 2);
			assert.ok(menu.items[0]);
			assert.ok(menu.items[1]);
			assert.equal(menu.items[0].title, "LearnHarness: Study selection");
			assert.equal(menu.items[1].title, "LearnHarness: Ask LearnHarness about selection");
		});

		it("editor-menu without selection adds zero items", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);
			await plugin.onload();

			const menu = new MockMenu();
			const editor = new MockEditor("Note content here", "");
			const view = new MockMarkdownView(new MockTFile("Note.md"), editor);

			app.workspace.trigger("editor-menu", menu, editor, view);
			assert.equal(menu.items.length, 0);
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 7. Graceful Offline Error Handling & Notice Emission                   */
	/* ---------------------------------------------------------------------- */
	describe("Graceful Offline & Error Handling", () => {
		it("displays clean Notice when server is unreachable (ECONNREFUSED) without uncaught exception", async () => {
			const app = new MockApp();
			const note = new MockTFile("Test.md", "content");
			app.vault.addFile(note);
			app.workspace.activeFile = note;

			const plugin = createTestPlugin(app);
			// Point to an unused loopback port
			plugin.transport.updateSettings({ serverUrl: "http://127.0.0.1:58998" });

			// executeStudyCurrentNote should NOT throw; it catches and notifies
			const res = await executeStudyCurrentNote(plugin);
			assert.equal(res, null);
			assert.equal(
				plugin.lastNotice,
				"LearnHarness is offline or unreachable. Please start LearnHarness to study notes.",
			);
		});

		it("displays clean Notice when request times out", async () => {
			const plugin = createTestPlugin();
			const err = new BridgeTransportError("Request timed out after 5000ms", {
				code: "ETIMEDOUT",
			});

			handleBridgeError(plugin, err, "study note");
			assert.equal(
				plugin.lastNotice,
				"LearnHarness is offline or unreachable. Please start LearnHarness to study notes.",
			);
		});

		it("prompts user to configure active project when activeProjectId is missing", async () => {
			const app = new MockApp();
			const note = new MockTFile("ActiveProjectTest.md", "content");
			app.workspace.activeFile = note;

			const plugin = createTestPlugin(app);
			plugin.settings.activeProjectId = ""; // Empty activeProjectId

			lastRequestBody = null;
			const res = await executeStudyCurrentNote(plugin);
			assert.equal(res, null);
			assert.equal(lastRequestBody, null, "Should not make network call without project");
			assert.equal(
				plugin.lastNotice,
				"LearnHarness: No project selected. Please configure an active project in settings.",
			);
		});

		it("displays clean Notice for HTTP 401 Unauthorized", () => {
			const plugin = createTestPlugin();
			const err = new BridgeTransportError("Unauthorized", {
				status: 401,
				code: "UNAUTHORIZED",
			});

			handleBridgeError(plugin, err, "test");
			assert.equal(
				plugin.lastNotice,
				"LearnHarness: Authentication required. Please check your API key in settings.",
			);
		});

		it("displays clean Notice for HTTP 403 Forbidden", () => {
			const plugin = createTestPlugin();
			const err = new BridgeTransportError("Forbidden", {
				status: 403,
				code: "FORBIDDEN",
			});

			handleBridgeError(plugin, err, "test");
			assert.equal(
				plugin.lastNotice,
				"LearnHarness: Access denied. Please verify project permissions.",
			);
		});

		it("displays clean Notice for HTTP 404 Not Found", () => {
			const plugin = createTestPlugin();
			const err = new BridgeTransportError("Not Found", {
				status: 404,
				code: "NOT_FOUND",
			});

			handleBridgeError(plugin, err, "test");
			assert.equal(
				plugin.lastNotice,
				"LearnHarness: Service endpoint not found. Please verify LearnHarness version.",
			);
		});
	});

	/* ---------------------------------------------------------------------- */
	/* 8. Plugin Lifecycle & Teardown                                         */
	/* ---------------------------------------------------------------------- */
	describe("Plugin Lifecycle & Event Teardown", () => {
		it("properly detaches event listeners and clears state on onunload", async () => {
			const app = new MockApp();
			const plugin = createTestPlugin(app);

			await plugin.onload();
			assert.equal(plugin.isLoaded, true);
			assert.equal(plugin.eventRefs.length, 2);
			assert.ok(plugin.commands.size > 0);
			assert.ok(plugin.statusBarItem !== undefined);

			await plugin.onunload();
			assert.equal(plugin.isLoaded, false);
			assert.equal(plugin.commands.size, 0);
			assert.equal(plugin.statusBarItem, undefined);
			assert.equal(app.workspace.removedRefs.length, 2);
			assert.equal(plugin.eventRefs.length, 0);
		});
	});
});
