import { createRoot } from 'react-dom/client'
import '../styles/overlay.css'
import { Overlay } from './Overlay'

const container = document.getElementById('overlay-root')
if (!container) throw new Error('Overlay root container is missing from overlay.html')

createRoot(container).render(<Overlay />)
