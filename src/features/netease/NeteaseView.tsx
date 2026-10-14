import { PlatformView } from '../online/PlatformView'
import { getProvider } from '../online/registry'
import { NeteaseLogin } from './NeteaseLogin'
import { setLoginOpen, useNeteaseLoginOpen } from './store'

/**
 * 网易云音乐, as an instance of the shared platform screen.
 *
 * The screen itself - search, result tabs, collections, the account strip, the
 * quality disclosure, the failure banner - is `features/online/PlatformView.tsx`
 * and is driven entirely by Netease's declared capabilities. What is left here is
 * the one thing that is genuinely Netease's: its sign-in dialog, which has a QR
 * code and a phone form and is unlike any other platform's.
 *
 * Before the provider layer, this file was ~500 lines of state, layout and Netease
 * specifics that would have had to be copied for the next platform. The copy is
 * what the layer removed.
 */
export function NeteaseView() {
  const provider = getProvider('netease')
  const loginOpen = useNeteaseLoginOpen()

  if (!provider) {
    // Only reachable if the platform was never registered, which is a programming
    // error rather than a runtime condition - so it says so instead of rendering a
    // blank page that looks like an empty catalogue.
    return <div className="notice">网易云音乐平台没有注册（这是程序错误，请反馈）。</div>
  }

  return (
    <>
      <PlatformView provider={provider} onLogin={() => setLoginOpen(true)} />
      {loginOpen ? <NeteaseLogin onClose={() => setLoginOpen(false)} /> : null}
    </>
  )
}
