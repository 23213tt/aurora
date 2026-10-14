import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import './features/player/actions'
/*
 * Playback wiring for the online source. Imported for its side effects, exactly
 * like `player/actions`: it is the module that connects the source to the
 * transport, so neither of them has to import the other.
 */
import './features/player/netease'
import { useNetease } from './features/netease/store'
import { setActiveStorageProfile } from './features/accounts/profile-storage'
import { useAccounts } from './features/accounts/store'

/*
 * Establish the profile before anything renders.
 *
 * Profile-scoped storage decides where data lands from a module-level variable,
 * so a write that happens while no profile exists lands in a placeholder slot
 * that no profile will ever read - and is then discarded when the real profile
 * loads. Doing this here rather than in an effect closes that window entirely:
 * by the time any component mounts, there is a profile and the stores are
 * already pointing at its slot.
 */
useAccounts.getState().ensureDefault()
setActiveStorageProfile(useAccounts.getState().activeId)

/*
 * Ask the online source whether it is usable and who is signed in.
 *
 * Deliberately not awaited and deliberately not fatal: it is a network round
 * trip to a third-party service on a cold start, and the offline parts of the
 * app - which is nearly all of it - must not wait for it or fail with it.
 */
void useNetease.getState().init()

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root is missing from index.html')

// Deliberately not wrapped in StrictMode: its double-invoked effects would
// build and tear down the Web Audio graph twice, which produces audible
// glitches and duplicate Media Session registrations.
createRoot(container).render(<App />)
