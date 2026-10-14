import { useCallback, useEffect, useState } from 'react'
import type { NeteaseAccount } from '../env'
import { hasNeteaseBackend, netease } from '../netease/api'
import { useNetease } from '../netease/store'
import { Check, Close, Lock, Refresh } from './icons'

interface NeteaseLoginProps {
  onClose(): void
  /** Called with the signed-in account. The store is already updated by then. */
  onSuccess?(account: NeteaseAccount): void
}

/** How often the QR code is polled. Two seconds matches the upstream's own QR TTL. */
const POLL_MS = 2000

type Tab = 'qr' | 'phone'

type QrState =
  | { kind: 'loading' }
  | { kind: 'ready'; image: string }
  | { kind: 'scanned' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string }

/**
 * Sign-in for the online source.
 *
 * A modal rather than a page: it is a short errand in the middle of something
 * else (opening a playlist, a daily recommendation), and it is the only flow in
 * the app that needs a QR code to stay on screen while the user reaches for
 * their phone.
 *
 * The QR is polled on a timer that is cleared on unmount *and* on close, so a
 * dismissed dialog can never keep asking the upstream about a code nobody is
 * looking at. Every call is also guarded by a cancelled flag: the upstream call
 * is faster than a user is, but not faster than a dialog.
 */
export function NeteaseLogin({ onClose, onSuccess }: NeteaseLoginProps) {
  const [tab, setTab] = useState<Tab>('qr')
  const [qr, setQr] = useState<QrState>({ kind: 'loading' })
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneError, setPhoneError] = useState<string | null>(null)

  /**
   * Recreated on every new code, which is what makes the poll loop restart
   * cleanly when a code expires: `useEffect` keys on it and tears the old timer
   * down.
   */
  const [nonce, setNonce] = useState(0)

  const finish = useCallback(
    (account: NeteaseAccount) => {
      useNetease.getState().loggedIn(account)
      onSuccess?.(account)
    },
    [onSuccess]
  )

  /** Create a code and poll it until it is used, expires, or the dialog closes. */
  useEffect(() => {
    if (tab !== 'qr') return
    if (!hasNeteaseBackend) {
      setQr({ kind: 'failed', message: '浏览器预览模式没有主进程，无法显示二维码' })
      return
    }

    let alive = true
    let timer = 0
    setQr({ kind: 'loading' })

    const poll = async (key: string) => {
      const result = await netease.qrCheck(key)
      if (!alive) return

      if (result.status === 'confirmed' && result.account) {
        finish(result.account)
        return
      }
      if (result.status === 'scanned') {
        setQr({ kind: 'scanned' })
      }
      if (result.status === 'expired') {
        // A fresh code, not an error: the countdown running out is the normal
        // way this dialog behaves if the user takes a phone call.
        setQr({ kind: 'expired' })
        return
      }
      if (result.status === 'failed') {
        setQr({ kind: 'failed', message: result.message ?? '二维码登录失败' })
        return
      }
      timer = window.setTimeout(() => void poll(key), POLL_MS)
    }

    const start = async () => {
      try {
        const created = await netease.qrCreate()
        if (!alive) return
        // The upstream hands back a data URL, so it renders without a network
        // request and without an origin the CSP would have to allow.
        setQr({ kind: 'ready', image: created.imageDataUrl })
        timer = window.setTimeout(() => void poll(created.key), POLL_MS)
      } catch (error) {
        if (!alive) return
        setQr({
          kind: 'failed',
          message: error instanceof Error ? error.message : '无法创建二维码'
        })
      }
    }

    void start()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [tab, nonce, finish])

  const submitPhone = async (event: React.FormEvent) => {
    event.preventDefault()
    if (phoneBusy) return
    setPhoneError(null)
    setPhoneBusy(true)
    try {
      const result = await netease.loginCellphone(phone.trim(), password)
      if (result.ok && result.account) {
        finish(result.account)
        return
      }
      /*
       * The upstream's own message is shown verbatim: "密码错误" and "需要验证码"
       * are different problems with different next actions, and replacing them
       * with one sentence of our own would hide which one happened.
       */
      setPhoneError(result.message ?? '登录失败，请检查手机号和密码')
    } catch (error) {
      setPhoneError(error instanceof Error ? error.message : '登录请求失败')
    } finally {
      setPhoneBusy(false)
    }
  }

  return (
    <div className="ne-modal" role="dialog" aria-modal="true" aria-label="登录网易云音乐">
      <div className="ne-modal__scrim" onPointerDown={onClose} role="presentation" />
      <div className="ne-modal__panel">
        <header className="ne-modal__head">
          <h2 className="ne-modal__title">登录网易云音乐</h2>
          <button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭登录窗口">
            <Close size={15} />
          </button>
        </header>

        <div className="seg ne-modal__tabs">
          <button className={tab === 'qr' ? 'is-active' : ''} onClick={() => setTab('qr')}>
            二维码
          </button>
          <button className={tab === 'phone' ? 'is-active' : ''} onClick={() => setTab('phone')}>
            手机号密码
          </button>
        </div>

        {tab === 'qr' ? (
          <div className="ne-modal__body">
            <div className={`ne__qr is-${qr.kind}`}>
              {qr.kind === 'ready' && qr.image ? (
                <img src={qr.image} alt="登录二维码" width={168} height={168} />
              ) : null}
              {qr.kind === 'loading' ? <span className="ne__qr-hint">正在获取二维码…</span> : null}
              {qr.kind === 'scanned' ? (
                <span className="ne__qr-hint">
                  <Check size={18} /> 已扫描，请在手机上确认
                </span>
              ) : null}
              {qr.kind === 'expired' ? (
                <span className="ne__qr-hint">
                  二维码已过期
                  <button className="btn btn--small" onClick={() => setNonce((n) => n + 1)}>
                    <Refresh size={13} /> 换一张
                  </button>
                </span>
              ) : null}
              {qr.kind === 'failed' ? <span className="ne__qr-hint">{qr.message}</span> : null}
            </div>
            <p className="ne-modal__note">
              用网易云音乐手机客户端扫描二维码。二维码每两分钟过期，过期后点「换一张」。
            </p>
          </div>
        ) : (
          <form className="ne-modal__body" onSubmit={submitPhone}>
            <label className="ne-field">
              <span>手机号</span>
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="numeric"
                autoComplete="username"
                placeholder="手机号"
                maxLength={20}
              />
            </label>
            <label className="ne-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="密码"
                maxLength={64}
              />
            </label>

            {phoneError ? <div className="ne-modal__error">{phoneError}</div> : null}

            <div className="ne-modal__actions">
              <button className="btn btn--accent" type="submit" disabled={phoneBusy || !phone.trim() || !password}>
                <Lock size={14} />
                {phoneBusy ? '登录中…' : '登录'}
              </button>
            </div>

            <p className="ne-modal__note">
              账号密码只通过主进程转发给网易云，Aurora 自己不保存；登录后 cookie 由主进程保管。
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
