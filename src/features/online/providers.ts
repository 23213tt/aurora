import { registerNeteaseProvider } from '../netease/provider'
import { registerQqProvider } from './qq-provider'

/**
 * Fill the provider registry.
 *
 * **Adding a platform is three lines here plus its own module**: a provider object
 * that declares its capabilities and collections, a backend of the handful of
 * functions the shared state machine calls, and a `register` call added below.
 * Nothing in the shell, the rail, the search screen or the settings page changes,
 * because all four read the registry.
 *
 * Called once from the app entry point rather than at the bottom of each platform
 * module, so registration order is visible in one place - it is the order the rail
 * and the search tabs display, and order that is decided by import order is order
 * nobody can find.
 *
 * QQ is registered unconditionally and answers `available() === false` when this
 * build has no QQ client. That is deliberate: the registry holds what the app
 * *supports*, and `listAvailableProviders()` is what the interface renders, so a
 * platform can exist in the settings page before it exists in the rail.
 */
export function registerProviders(): void {
  registerNeteaseProvider()
  registerQqProvider()
}
