import { PlatformView } from '../online/PlatformView'
import { getProvider } from '../online/registry'
import { QqLogin, setLoginOpen, useQqLoginOpen } from './QqLogin'

/**
 * QQ Music, as an instance of the shared platform screen.
 *
 * Everything the screen does - search, result tabs, the account strip, the quality
 * disclosure, the failure banner - comes from `features/online/PlatformView.tsx`
 * driven by QQ's declared capabilities. What is left here is the sign-in dialog,
 * which is genuinely QQ's own.
 *
 * QQ declares no collections, so its rail section is just the one entry that leads
 * to this screen. That is honest rather than unfinished: the upstream endpoints
 * this client uses cover search, playback and lyrics, and there is no verified
 * daily-recommendations or cloud-drive equivalent to offer. A section listing four
 * doors that all open the same page would be worse than one that opens it.
 */
export function QqView() {
  const provider = getProvider('qq')
  const loginOpen = useQqLoginOpen((state) => state.open)

  if (!provider) {
    return <div className="notice">QQ 音乐平台没有注册（这是程序错误，请反馈）。</div>
  }

  return (
    <>
      <PlatformView provider={provider} onLogin={() => setLoginOpen(true)} />
      {loginOpen ? <QqLogin onClose={() => setLoginOpen(false)} /> : null}
    </>
  )
}
