import { registerProviders } from './providers'

/**
 * Registration, as a side effect.
 *
 * `providers.ts` owns the order; this module exists so the entry point can be one
 * plain `import './features/online/register'` with no call site to forget. Module
 * side effects are used deliberately sparingly in this app - `features/player/
 * actions` and `features/player/netease` are the other two - and the rule they
 * share is that the effect must be idempotent and must be the *only* way the
 * thing gets set up, so there is no ordering question for a reader to answer.
 */
registerProviders()
