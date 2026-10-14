import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { useOnlineStore } from '../online/store'
import './QqLogin.css'

/**
 * QQ Music's sign-in dialog: a QR code, and nothing else.
 *
 * QQ has no phone/password form in the path this client uses, so unlike Netease's
 * dialog there is one mode here. That asymmetry is deliberate and is exactly why
 * the sign-in UI stays per platform instead of being abstracted: a shared dialog
 * would have to model the union of every platform's flows, which is more code than
 * the two dialogs it would replace.
 *
 * Signing in matters more here than it does for Netease. Measured on real
 * requests: signed out, only 18.4% of a 293-track sample is playable at all (free
 * tracks, 128 kbps); everything else answers `result=104003`. So this dialog is
 * the difference between a working platform and a list of songs that do nothing
 * when clicked - which is why the section offers it prominently rather than
 * hiding it until something fails.
 */

/** Which profile's dialog is open. Kept in a store so the rail can open it too. */
export const useQqLoginOpen = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

const setLoginOpen = (open: boolean): void => useQqLoginOpen.getState().setOpen(open)

type QrState =
  | { kind: 'loading' }
  | { kind: 'ready'; key: string; image: string }
  | { kind: 'scanned' }
  | { kind: 'failed'; message: string }

/** QQ reports no "scanned but not confirmed" state, so this is only ever set locally. */
const POLL_MS = 1800

export function QqLogin({ onClose }: { onClose(): void }) {
  const [qr, setQr] = useState<QrState>({ kind: 'loading' })
  /**
   * Recreated on every new code, so the poll loop restarts cleanly when a code
   * expires: `useEffect` keys on it and tears the old timer down.
   */
  const [nonce, setNonce] = useState(0)

  const finish = useCallback(() => {
    /*
     * Re-read the account from the main process, which is the side that holds the
     * cookie. Asking again is one cheap IPC call and is the only way the renderer's
     * idea of the session is verified rather than assumed from what upstream said.
     */
    void useOnlineStore('qq').getState().refreshAccount()
    onClose()
  }, [onClose])

  useEffect(() => {
    const bridge = window.aurora?.qq
    if (!bridge) {
      setQr({ kind: 'failed', message: '浏览器预览模式没有主进程，无法显示二维码' })
      return
    }

    let alive = true
    let timer = 0
    setQr({ kind: 'loading' })

    const poll = async (key: string): Promise<void> => {
      const result = await bridge.qrCheck(key)
      if (!alive) return

      if (result.status === 'confirmed') {
        finish()
        return
      }
      if (result.status === 'expired' || result.status === 'failed') {
        // A new code is the only recovery, and it is one click away.
        setQr({ kind: 'failed', message: result.message ?? '二维码已过期' })
        return
      }
      // `waiting` and (theoretically) `scanned` both mean keep asking.
      if (result.status === 'scanned') setQr({ kind: 'scanned' })
      timer = window.setTimeout(() => void poll(key), POLL_MS)
    }

    void (async () => {
      try {
        const created = await bridge.qrCreate()
        if (!alive) return
        if (!created.imageDataUrl) {
          setQr({ kind: 'failed', message: '没有拿到二维码，请重试' })
          return
        }
        setQr({ kind: 'ready', key: created.key, image: created.imageDataUrl })
        timer = window.setTimeout(() => void poll(created.key), POLL_MS)
      } catch (error) {
        if (!alive) return
        setQr({ kind: 'failed', message: error instanceof Error ? error.message : '二维码创建失败' })
      }
    })()

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [finish, nonce])

  return (
    <div className="qq-login" role="dialog" aria-modal="true" aria-label="登录 QQ 音乐">
      <div className="qq-login__panel">
        <header className="qq-login__head">
          <h2 className="qq-login__title">登录 QQ 音乐</h2>
          <button className="qq-login__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="qq-login__body">
          <div className="qq-login__code">
            {qr.kind === 'ready' ? (
              <img className="qq-login__image" src={qr.image} alt="QQ 音乐登录二维码" />
            ) : (
              <div className="qq-login__placeholder">
                {qr.kind === 'loading' ? '正在获取二维码…' : null}
                {qr.kind === 'scanned' ? '已扫码，请在手机上确认' : null}
                {qr.kind === 'failed' ? qr.message : null}
              </div>
            )}
          </div>

          <p className="qq-login__hint">
            用手机 QQ 扫一扫。登录后才能播放需要会员的歌曲 —— 未登录时只有免费歌曲（128k）能播。
          </p>

          {qr.kind === 'failed' ? (
            <button className="btn btn--small" onClick={() => setNonce((value) => value + 1)}>
              换一个二维码
            </button>
          ) : null}

          <p className="qq-login__note">
            这不是官方客户端：接入的是第三方逆向接口，仅供个人学习自用。能播的只有你这个账号本来就有权限播的内容。
          </p>
        </div>
      </div>
    </div>
  )
}

export { setLoginOpen }
