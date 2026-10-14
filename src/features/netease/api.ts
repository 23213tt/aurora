import { bridge, isNative } from '../../bridge'
import type { NeteaseApi } from '../../env'

/**
 * The one way the online source is reached.
 *
 * Reading `window.aurora.netease` directly would work in Electron and crash the
 * browser preview, and the preview is how the interface gets reviewed without
 * launching the app. Going through the bridge's fallback keeps every call
 * answerable in both worlds: the fallback returns empty results and
 * "signed out" instead of throwing, so the view renders its real empty states
 * rather than an error boundary.
 */
export const netease: NeteaseApi = isNative
  ? (window.aurora?.netease ?? bridge.netease)
  : bridge.netease

/**
 * Whether the online source can actually reach an upstream server.
 *
 * False in the browser preview, where there is no main process to fetch with.
 * The interface uses this to say "this build has no online source" once, at the
 * top, instead of surfacing a network failure for every single action.
 */
export const hasNeteaseBackend = isNative && Boolean(window.aurora?.netease)

