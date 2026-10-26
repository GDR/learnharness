/**
 * Render tests for Milestone A Slice 5: Project Navigation UI.
 * Verifies SSR markup and attributes for ProjectSwitcher and ProjectSection.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ProjectSection } from "../components/settings/project-section.tsx";
import { ProjectSwitcher } from "../components/sidebar.tsx";

describe("Milestone A Slice 5 — Project Navigation UI (SSR)", () => {
	it("SettingsDialogBody registers Projects in nav", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes('data-testid="settings-nav-projects"'), "nav includes projects tab");
		assert.ok(html.includes("Projects"), "nav label is Projects");
	});

	it("SettingsDialogBody lands on Projects section when initialSection='projects'", () => {
		const html = renderToStaticMarkup(
			<SettingsDialogBody onClose={() => {}} initialSection="projects" />,
		);
		const navTagMatch = html.match(/<button[^>]*data-testid="settings-nav-projects"[^>]*>/);
		assert.ok(navTagMatch, "found settings-nav-projects button tag");
		assert.ok(navTagMatch[0].includes('aria-current="true"'), "projects tab has aria-current=true");
		assert.ok(html.includes("Loading settings…"), "shows loading state under SSR");
	});

	it("ProjectSection renders groups and creation form under SSR", () => {
		const html = renderToStaticMarkup(<ProjectSection />);
		assert.ok(html.includes('data-testid="section-projects"'), "carries section-projects testid");
		assert.ok(html.includes("Multi-project workspace isolation and settings"), "carries section hint");
		assert.ok(html.includes('data-testid="group-create-project"'), "carries group-create-project");
		assert.ok(html.includes('data-testid="input-new-project-name"'), "carries input-new-project-name");
		assert.ok(html.includes('data-testid="btn-create-project"'), "carries btn-create-project");
	});

	it("ProjectSwitcher renders trigger and initial placeholder under SSR", () => {
		const html = renderToStaticMarkup(<ProjectSwitcher />);
		assert.ok(html.includes('data-testid="project-switcher"'), "carries project-switcher testid");
		assert.ok(html.includes('data-testid="project-switcher-trigger"'), "carries trigger testid");
		assert.ok(html.includes('data-testid="project-switcher-name"'), "carries project-switcher-name");
	});
});
