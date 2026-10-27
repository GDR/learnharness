/**
 * Render and unit tests for Milestone B Slice 5: Project Settings Source Selector UI.
 * Verifies SSR markup, test IDs, attributes, labels, default values, and edge cases
 * for SourceSelector and ProjectSection integration.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	SourceSelector,
	extractSourceRootPath,
} from "../components/settings/source-selector.tsx";
import { ProjectSection } from "../components/settings/project-section.tsx";
import {
	DEFAULT_SOURCE_EXCLUDE,
	type Project,
	type ProjectSource,
	type Vault,
} from "../src/core/index.ts";

const mockVaultA: Vault = {
	id: "vault_research",
	displayName: "Research Vault",
	kind: "obsidian",
	bindings: [
		{
			deviceId: "local",
			rootPath: "/Users/test/vaults/research",
			status: "available",
		},
	],
};

const mockVaultB: Vault = {
	id: "vault_offline",
	displayName: "Offline Vault",
	kind: "obsidian",
	bindings: [
		{
			deviceId: "local",
			rootPath: "/Volumes/External/vault",
			status: "unavailable",
		},
	],
};

const mockSourceEntire: ProjectSource = {
	id: "src_entire",
	projectId: "proj_active",
	vaultId: "vault_research",
	include: ["**/*"],
	exclude: [".obsidian/**", ".trash/**"],
	recursive: true,
	enabled: true,
	syncMode: "manual",
	deletionPolicy: "retain",
	createdAt: "2026-10-27T00:00:00.000Z",
};

const mockSourceSubfolder: ProjectSource = {
	id: "src_subfolder",
	projectId: "proj_active",
	vaultId: "vault_offline",
	include: ["Physics/**/*"],
	exclude: [".obsidian/**", ".trash/**", ".git/**"],
	recursive: false,
	enabled: false,
	syncMode: "automatic",
	deletionPolicy: "deactivate",
	createdAt: "2026-10-27T01:00:00.000Z",
};

const mockProject: Project = {
	id: "proj_active",
	name: "Quantum Physics Lab",
	description: "Notes and research on quantum mechanics",
	status: "active",
	createdAt: "2026-10-26T12:00:00.000Z",
	updatedAt: "2026-10-26T12:00:00.000Z",
	settings: {
		defaultStudyScope: "all",
		sourceGrounding: "strict",
	},
};

describe("Milestone B Slice 5 — extractSourceRootPath", () => {
	it("returns empty string when include matches whole vault", () => {
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: ["**/*"] }),
			"",
		);
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: ["*.md"] }),
			"",
		);
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: [] }),
			"",
		);
	});

	it("extracts single folder prefix", () => {
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: ["Physics/**/*"] }),
			"Physics",
		);
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: ["Physics/**"] }),
			"Physics",
		);
		assert.equal(
			extractSourceRootPath({ ...mockSourceEntire, include: ["Notes/*.md"] }),
			"Notes",
		);
	});

	it("extracts nested subfolder path", () => {
		assert.equal(
			extractSourceRootPath({
				...mockSourceEntire,
				include: ["School/Physics/Notes/**/*"],
			}),
			"School/Physics/Notes",
		);
	});

	it("prefers explicit rootPath property if set", () => {
		const custom = {
			...mockSourceEntire,
			rootPath: "CustomFolder",
			include: ["**/*"],
		};
		assert.equal(extractSourceRootPath(custom), "CustomFolder");
	});

	it("returns empty string when patterns have mismatched folders", () => {
		assert.equal(
			extractSourceRootPath({
				...mockSourceEntire,
				include: ["Physics/**", "Chemistry/**"],
			}),
			"",
		);
	});

	it("normalizes Windows backslashes in include patterns and rootPath", () => {
		assert.equal(
			extractSourceRootPath({
				...mockSourceEntire,
				include: ["Physics\\Mechanics/**/*"],
			}),
			"Physics/Mechanics",
		);
		const custom = {
			...mockSourceEntire,
			rootPath: "Notes\\Physics",
			include: ["**/*"],
		};
		assert.equal(
			extractSourceRootPath(custom as unknown as ProjectSource),
			"Notes/Physics",
		);
	});
});

describe("Milestone B Slice 5 — SourceSelector SSR Rendering", () => {
	it("renders loading state when initial data is absent under SSR", () => {
		const html = renderToStaticMarkup(<SourceSelector projectId="proj_active" />);
		assert.ok(html.includes('data-testid="source-selector"'), "has source-selector container");
		assert.ok(html.includes('data-testid="sources-loading"'), "shows sources-loading");
		assert.ok(html.includes("Loading sources…"), "shows loading text");
		assert.ok(html.includes("Attached Obsidian Sources"), "shows header");
	});

	it("renders empty state and attach form when initialSources is empty", () => {
		const html = renderToStaticMarkup(
			<SourceSelector
				projectId="proj_active"
				initialSources={[]}
				initialVaults={[mockVaultA]}
			/>,
		);
		assert.ok(html.includes('data-testid="sources-empty"'), "shows sources-empty");
		assert.ok(
			html.includes("No sources attached to this project workspace."),
			"displays empty explanation",
		);

		// Attach form exists
		assert.ok(html.includes('data-testid="form-attach-source"'), "form rendered");
		assert.ok(html.includes('data-testid="select-vault"'), "vault select rendered");
		assert.ok(html.includes("Research Vault"), "vault option text rendered");
		assert.ok(html.includes('data-testid="input-source-path"'), "folder path input");
		assert.ok(html.includes('data-testid="source-path-preview"'), "path preview rendered");
		assert.ok(html.includes("Research Vault/**"), "preview shows vault/** default");
		assert.ok(html.includes('data-testid="input-include-globs"'), "include globs input");
		assert.ok(html.includes('value="**/*"'), "default include value **/*");
		assert.ok(html.includes('data-testid="input-exclude-globs"'), "exclude globs input");
		assert.ok(html.includes('data-testid="checkbox-recursive"'), "recursive checkbox");
		assert.ok(html.includes('data-testid="select-deletion-policy"'), "deletion policy select");
		assert.ok(html.includes('data-testid="btn-attach-source"'), "attach source button");
	});

	it("renders helpful message when no vaults are registered", () => {
		const html = renderToStaticMarkup(
			<SourceSelector
				projectId="proj_active"
				initialSources={[]}
				initialVaults={[]}
			/>,
		);
		assert.ok(html.includes('data-testid="no-vaults-notice"'), "has no-vaults-notice");
		assert.ok(
			html.includes("No Obsidian vaults registered. Add a vault in Vault Settings."),
			"helpful vault guidance displayed",
		);
		assert.ok(!html.includes('data-testid="form-attach-source"'), "form is hidden");
	});

	it("renders attached sources list with formatted path preview and badges", () => {
		const html = renderToStaticMarkup(
			<SourceSelector
				projectId="proj_active"
				initialSources={[mockSourceEntire, mockSourceSubfolder]}
				initialVaults={[mockVaultA, mockVaultB]}
			/>,
		);

		// Container & list
		assert.ok(html.includes('data-testid="sources-list"'), "sources-list rendered");
		assert.ok(html.includes('data-testid="source-row-src_entire"'), "entire row");
		assert.ok(html.includes('data-testid="source-row-src_subfolder"'), "subfolder row");

		// Entire vault source verification
		assert.ok(
			html.includes('data-testid="source-vault-name-src_entire"'),
			"vault name testid",
		);
		assert.ok(html.includes("Research Vault"), "vault display name rendered");
		assert.ok(
			html.includes('data-testid="source-path-preview-src_entire"'),
			"entire path preview testid",
		);
		assert.ok(
			html.includes("Research Vault (Entire Vault)"),
			"displays (Entire Vault) when no subfolder",
		);
		assert.ok(
			html.includes('data-testid="source-availability-src_entire"'),
			"availability testid",
		);
		assert.ok(html.includes(">available<"), "available badge rendered");
		assert.ok(
			html.includes('data-testid="source-status-enabled-src_entire"'),
			"enabled status testid",
		);
		assert.ok(html.includes(">enabled<"), "status is enabled");
		assert.ok(
			html.includes('data-testid="source-status-recursive-src_entire"'),
			"recursive status testid",
		);
		assert.ok(html.includes(">recursive<"), "status is recursive");
		assert.ok(
			html.includes('data-testid="source-status-sync-src_entire"'),
			"sync status testid",
		);
		assert.ok(html.includes(">manual<"), "sync mode is manual");
		assert.ok(
			html.includes('data-testid="source-status-deletion-src_entire"'),
			"deletion status testid",
		);
		assert.ok(html.includes(">retain<"), "deletion policy is retain");
		assert.ok(
			html.includes('data-testid="source-doc-count-src_entire"'),
			"doc count testid",
		);
		assert.ok(html.includes("0 documents"), "document count rendered");
		assert.ok(
			html.includes('data-testid="btn-toggle-source-src_entire"'),
			"toggle button testid",
		);
		assert.ok(html.includes(">Disable<"), "toggle text is Disable for enabled source");
		assert.ok(
			html.includes('data-testid="btn-detach-source-src_entire"'),
			"detach button testid",
		);
		assert.ok(html.includes("Include: **/*"), "include globs displayed");
		assert.ok(
			html.includes("Exclude: .obsidian/**, .trash/**"),
			"exclude globs displayed",
		);

		// Subfolder source verification
		assert.ok(html.includes("Offline Vault / Physics"), "subfolder formatted path");
		assert.ok(html.includes(">unavailable<"), "unavailable badge rendered");
		assert.ok(html.includes(">disabled<"), "status is disabled");
		assert.ok(html.includes(">shallow<"), "status is shallow when recursive=false");
		assert.ok(html.includes(">watch<"), "status is watch when syncMode=automatic");
		assert.ok(html.includes(">deactivate<"), "deletion policy is deactivate");
		assert.ok(html.includes(">Enable<"), "toggle text is Enable for disabled source");
	});

	it("renders default exclude globs matching DEFAULT_SOURCE_EXCLUDE in form value and placeholder", () => {
		const html = renderToStaticMarkup(
			<SourceSelector
				projectId="proj_active"
				initialSources={[]}
				initialVaults={[mockVaultA]}
			/>,
		);
		const expectedGlobs = DEFAULT_SOURCE_EXCLUDE.join(", ");
		assert.ok(
			html.includes(`value="${expectedGlobs}"`),
			`default exclude value matches DEFAULT_SOURCE_EXCLUDE: ${expectedGlobs}`,
		);
		assert.ok(
			html.includes(".git/**"),
			"default exclude includes .git/**",
		);
		assert.ok(
			html.includes("node_modules/**"),
			"default exclude includes node_modules/**",
		);
		assert.ok(
			html.includes(`placeholder="${expectedGlobs}"`),
			"exclude globs placeholder matches DEFAULT_SOURCE_EXCLUDE",
		);
	});

	it("normalizes Windows backslashes in folder path input to forward slashes in preview", () => {
		const html = renderToStaticMarkup(
			<SourceSelector
				projectId="proj_active"
				initialSources={[]}
				initialVaults={[mockVaultA]}
				initialFolderPath={"Quantum\\Physics\\Notes"}
			/>,
		);
		assert.ok(
			html.includes("Research Vault/Quantum/Physics/Notes/**"),
			"path preview normalizes backslashes to forward slashes",
		);
	});
});

describe("Milestone B Slice 5 — ProjectSection with SourceSelector SSR Integration", () => {
	it("renders SourceSelector inside Active Workspace Settings group", () => {
		const html = renderToStaticMarkup(
			<ProjectSection
				initialProjects={[mockProject]}
				initialActiveProjectId="proj_active"
				initialSources={[mockSourceEntire]}
				initialVaults={[mockVaultA]}
			/>,
		);

		assert.ok(html.includes('data-testid="group-active-project"'), "active group present");
		assert.ok(html.includes('data-testid="row-project-name"'), "project name row present");
		assert.ok(html.includes('data-testid="row-project-description"'), "desc row present");
		assert.ok(html.includes('data-testid="row-project-scope"'), "scope row present");
		assert.ok(html.includes('data-testid="row-project-grounding"'), "grounding row present");

		// SourceSelector is nested inside Active Workspace Settings
		assert.ok(html.includes('data-testid="source-selector"'), "source-selector integrated");
		assert.ok(html.includes("Attached Obsidian Sources"), "attached sources header");
		assert.ok(html.includes('data-testid="source-row-src_entire"'), "attached source row rendered");
		assert.ok(html.includes("Research Vault (Entire Vault)"), "source path preview rendered");
	});
});

describe("Milestone B Slice 5 — Remediation & Static Contract Audits", () => {
	it("verifies loadData does not include selectedVaultId in dependency array", () => {
		const source = fs.readFileSync(
			new URL("../components/settings/source-selector.tsx", import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(
			source,
			/const loadData = useCallback\([\s\S]*?\], \[[^\]]*selectedVaultId[^\]]*\]\)/,
			"loadData must not depend on selectedVaultId to eliminate refetch loop",
		);
	});

	it("verifies loadData uses functional updater for setSelectedVaultId", () => {
		const source = fs.readFileSync(
			new URL("../components/settings/source-selector.tsx", import.meta.url),
			"utf8",
		);
		assert.match(
			source,
			/setSelectedVaultId\(\s*\(\s*curr(?:ent)?\s*\)\s*=>\s*curr(?:ent)?\s*\|\|\s*\(loadedVaults\[0\]\?\.id\s*\?\?\s*""\)\s*\)/,
			"loadData must use functional updater to avoid closing over selectedVaultId",
		);
	});

	it("verifies loadData invokes setLoading(true) at start when initialSources is absent", () => {
		const source = fs.readFileSync(
			new URL("../components/settings/source-selector.tsx", import.meta.url),
			"utf8",
		);
		assert.match(
			source,
			/const loadData = useCallback[\s\S]*?if \(initialSources === undefined\) \{\s*setLoading\(true\);\s*\}/,
			"loadData must set loading state when fetching initial data",
		);
	});

	it("verifies handleAttachSource normalizes backslashes before attaching", () => {
		const source = fs.readFileSync(
			new URL("../components/settings/source-selector.tsx", import.meta.url),
			"utf8",
		);
		assert.match(
			source,
			/const normalizedFolder = folderPath\.trim\(\)\.replace\(\/\\\\\/g,\s*"\/"\)/,
			"handleAttachSource must normalize Windows backslashes",
		);
	});

	it("verifies key={activeProject.id} is bound to SourceSelector in ProjectSection", () => {
		const source = fs.readFileSync(
			new URL("../components/settings/project-section.tsx", import.meta.url),
			"utf8",
		);
		assert.match(
			source,
			/<SourceSelector[^>]*\bkey=\{activeProject\.id\}/,
			"ProjectSection must pass key={activeProject.id} to SourceSelector for workspace isolation",
		);
	});
});

