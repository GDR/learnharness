/**
 * Tests for dock internal scroll area height cap calculation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateDockMaxH, DOCK_CHROME_RESERVE, DOCK_MIN_MAX_H } from "../components/dock-height.ts";

describe("calculateDockMaxH (the dock scroll area height cap)", () => {
	it("reserves room for fixed dock controls so the dock fits within the viewport", () => {
		// On a 13-inch MacBook or typical laptop viewport (e.g. 700px height):
		// Leaves 300px for confidence slider, thinking form, stats bar, and top breathing gap.
		assert.equal(calculateDockMaxH(700), 400);
		assert.equal(calculateDockMaxH(650), 350);
		assert.equal(calculateDockMaxH(800), 500);
	});

	it("clamps to DOCK_MIN_MAX_H on very short viewports", () => {
		assert.equal(calculateDockMaxH(400), DOCK_MIN_MAX_H);
		assert.equal(calculateDockMaxH(300), DOCK_MIN_MAX_H);
		assert.equal(calculateDockMaxH(100), DOCK_MIN_MAX_H);
	});

	it("scales smoothly on larger displays", () => {
		assert.equal(calculateDockMaxH(1200), 900);
	});
});
