import { useEffect, useState } from 'react'
import { bridge, isNative } from '../bridge'
import type { UpdateResult } from '../env'
import { Refresh } from './icons'

/**
 * Update status for the settings screen.
 *
 * Aurora checks and notifies; it never downloads or installs. The builds are
 * unsigned, so there is nothing to verify before replacing the running
 * executable - the release page, and the SmartScreen prompt that comes with an
 * unsigned installer, both belong in the user's own browser.
 */
export function UpdatePanel() {
  const [version, setVersion] = useState('—')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateResult | null>(null)
  const [autoCheck, setAutoCheck] = useState(true)

  useEffect(() => {
    void bridge.info().then((info) => setVersion(info.version))
    if (isNative) void bridge.updates.getAutoCheck().then(setAutoCheck)
  }, [])

  // The once-a-day background check can report at any moment.
  useEffect(() => bridge.updates.onAvailable(setResult), [])

  const run = async () => {
    setChecking(true)
    try {
      setResult(await bridge.updates.check())
    } finally {
      setChecking(false)
    }
  }

  const toggleAuto = async (enabled: boolean) => {
    setAutoCheck(await bridge.updates.setAutoCheck(enabled))
  }

  return (
    <section className="update">
      <div className="update__row">
        <div className="update__version">
          <span className="update__label">当前版本</span>
          <span className="update__number tnum">{version}</span>
        </div>

        {isNative ? (
          <button className="btn" onClick={() => void run()} disabled={checking}>
            <Refresh size={15} />
            {checking ? '正在检查' : '检查更新'}
          </button>
        ) : null}
      </div>

      {result ? (
        <div className={`update__result${result.state === 'available' ? ' is-available' : ''}`}>
          {result.state === 'current' ? (
            <p>已是最新的正式版本</p>
          ) : result.state === 'available' ? (
            <>
              <p className="update__headline">
                有新版本 <strong>{result.info.version}</strong>
                {result.info.name && result.info.name !== `Aurora ${result.info.version}`
                  ? ` · ${result.info.name}`
                  : ''}
              </p>
              {result.info.notes ? <pre className="update__notes">{result.info.notes}</pre> : null}
              <button className="btn btn--accent" onClick={() => void bridge.updates.open(result.info.url)}>
                打开下载页
              </button>
            </>
          ) : (
            <p>{result.message}</p>
          )}
        </div>
      ) : null}

      {isNative ? (
        <div className="update__row update__row--quiet">
          <div>
            <div className="update__label">每天自动检查一次</div>
            <p className="update__hint">只提示，不自动安装。安装包未签名</p>
          </div>
          <button
            className={`switch${autoCheck ? ' is-on' : ''}`}
            role="switch"
            aria-checked={autoCheck}
            onClick={() => void toggleAuto(!autoCheck)}
            aria-label="每天自动检查更新"
          >
            <span className="switch__dot" />
          </button>
        </div>
      ) : null}
    </section>
  )
}
