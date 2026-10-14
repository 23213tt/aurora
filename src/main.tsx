import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import './player/actions'
import { setActiveStorageProfile } from './accounts/profile-storage'
import { useAccounts } from './accounts/store'

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

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root is missing from index.html')

// Deliberately not wrapped in StrictMode: its double-invoked effects would
// build and tear down the Web Audio graph twice, which produces audible
// glitches and duplicate Media Session registrations.
createRoot(container).render(<App />)
