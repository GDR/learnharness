/**
 * Height cap for the dock's internal scroll areas (components/chat.tsx
 * DockOverlay, components/question-dock.tsx, components/practice-dock.tsx).
 *
 * Background:
 * On 2026-10-05, the dock height cap moved from fixed viewport fractions
 * (55dvh / 40vh) to a measured column cap (--dock-max-h) to avoid cutting
 * long problems short. However, subtracting only a 2rem breathing gap
 * (Math.max(el.clientHeight - 32, 160)) from the scroller column applied
 * the full available height directly to the question scroll area ALONE.
 *
 * Below the scroll area, the dock still renders non-scrolling controls:
 *   - Confidence slider (in quiz mode): ~40px
 *   - Thinking / answer form (textarea + submit button): ~140px-170px
 *   - Shell borders + stats bar + bottom padding: ~56px
 *   - Top clearance: ~34px
 * Total fixed chrome: ~300px.
 *
 * On smaller screens (e.g. 13" MacBooks with ~650-750px viewport height),
 * a tall question (such as code blocks with 20+ lines) would expand the total
 * dock height to (viewport - 32px) + 270px = viewport + 238px. Because the dock
 * is positioned `absolute; bottom: 0`, the top of the dock and the beginning of
 * the question/code rendered off-screen above the window, and attempts to scroll
 * the window triggered the collapse distance threshold.
 *
 * Reserving ~300px for the fixed dock chrome ensures the entire dock shell
 * always fits within the visible viewport, while the inner question or problem
 * container scrolls smoothly.
 */
export const DOCK_CHROME_RESERVE = 300;
export const DOCK_MIN_MAX_H = 160;

export function calculateDockMaxH(viewportH: number): number {
	return Math.max(viewportH - DOCK_CHROME_RESERVE, DOCK_MIN_MAX_H);
}
