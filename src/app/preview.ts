import { isNative } from '../bridge'

/**
 * Flags the preview build reads to open a specific screen or simulate load.
 *
 * These exist only for the browser preview: a screenshot harness needs a way to
 * reach a screen without clicking through the UI, and a benchmark needs to drive
 * the same store updates a visible window produces. Electron ignores all of them.
 */

/**
 * Preview benchmark mode (`#perf`).
 *
 * A headless renderer barely runs `requestAnimationFrame`, so the 60 Hz position
 * stream a visible window produces cannot be reproduced by letting the synthetic
 * driver run - the first attempt measured six renders in six seconds, which was
 * the rig failing rather than the app performing well. `#perf` drives the same
 * store update from a timer instead, which is what makes the render-cost claim
 * reproducible: 403 app renders before the playhead subscription was moved out
 * of the root, 4 after, for the same six seconds at 60 Hz.
 */
export const PERF_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'perf'

/**
 * Preview screen for the auto-scroll behaviour (`#songs-far`).
 *
 * With the demo library's 27 rows, starting playback around row 19 puts the
 * playing track below the fold, so the screenshot only shows it if the list
 * really did scroll itself.
 */
export const SCROLL_TEST_START = 18
export const SCROLL_TEST_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'songs-far'

/** Preview screen for the track actions menu, which otherwise needs a pointer. */
export const MENU_TEST_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'menu'

/**
 * Preview screen for search (`#search`).
 *
 * A search screen with an empty field shows only its own empty state, which says
 * nothing about whether results render - and the default source is the online one,
 * which a browser preview cannot reach at all. So this seeds a query *and* leaves
 * the screen on the local source, which is the only one that can answer here: the
 * screenshot then exercises the result list, the tabs and their counts.
 */
export const SEARCH_TEST_QUERY = !isNative && window.location.hash.replace(/^#/, '') === 'search' ? '夜' : ''
export const SEARCH_TEST_LOCAL = SEARCH_TEST_QUERY !== ''

/**
 * Preview stress harness: `window.__AURORA_STRESS = 5000` before the bundle runs.
 *
 * A personal library runs to thousands of rows, and the 27-row demo library cannot
 * answer what that costs. The seeder itself lives in a separate chunk
 * (`src/preview/stress.ts`, fetched on demand below) so the app bundle never
 * contains measurement code - see that file for why that matters more than an
 * `isNative` guard.
 */
export const STRESS_TRACKS = !isNative ? Number((window as Window & { __AURORA_STRESS?: number }).__AURORA_STRESS ?? 0) : 0
