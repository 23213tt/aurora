import { useEffect, useState } from 'react'
import { providerOf } from '../features/accounts/providers'
import type { Account } from '../features/accounts/store'
import { isNative } from '../bridge'
import type { NeteaseAccount } from '../env'
import { netease } from '../features/netease/api'
import { Check, Pencil, Plus, Trash } from '../ui/icons'

interface AccountsViewProps {
  accounts: Account[]
  activeId: string | null
  onCreate(label: string): void
  onActivate(id: string): void
  onRename(id: string, label: string): void
  onRemove(id: string): void
  /** Unbinds the online account from a profile. */
  onUnbindOnline(id: string): void
}

/**
 * Which Netease account each profile is signed in as.
 *
 * Asked once per profile on open. This is the screen where the two halves of
 * "an account" used to look unrelated - a local profile list that never
 * mentioned the online session at all - so the binding is shown on the profile
 * row itself rather than on a separate page.
 */
function useOnlineBindings(accounts: Account[]): Record<string, NeteaseAccount | null> {
  const [bindings, setBindings] = useState<Record<string, NeteaseAccount | null>>({})

  useEffect(() => {
    if (!isNative || !netease.accountFor) return
    let cancelled = false
    void (async () => {
      const next: Record<string, NeteaseAccount | null> = {}
      for (const account of accounts) {
        next[account.id] = await netease.accountFor(account.id)
      }
      if (!cancelled) setBindings(next)
    })()
    return () => {
      cancelled = true
    }
  }, [accounts])

  return bindings
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString('zh-CN')
  } catch {
    return ''
  }
}

/**
 * Local profiles.
 *
 * This screen used to also list the online services that are not integrated,
 * each tagged "planned". That was a mistake: a settings page is not a roadmap,
 * and six rows of things that do not exist read as six broken promises. Anything
 * that is not implemented is now simply absent from the interface - the reasons
 * and the extension points live in the README, where someone who wants to build
 * on this can find them.
 */
export function AccountsView({
  accounts,
  activeId,
  onCreate,
  onActivate,
  onRename,
  onRemove,
  onUnbindOnline
}: AccountsViewProps) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const bindings = useOnlineBindings(accounts)

  const commitNew = () => {
    const label = draft.trim()
    if (!label) return
    onCreate(label)
    setDraft('')
  }

  const commitRename = (id: string) => {
    const label = editLabel.trim()
    if (label) onRename(id, label)
    setEditing(null)
  }

  return (
    <div className="accounts">
      <section className="accounts__group">
        <ul className="profile-rows">
          {accounts.map((account) => {
            const isActive = account.id === activeId
            return (
              <li className={`profile-row${isActive ? ' is-active' : ''}`} key={account.id}>
                <span className="profile-row__avatar">{account.label.slice(0, 1)}</span>

                {editing === account.id ? (
                  <input
                    className="profile-row__edit"
                    value={editLabel}
                    autoFocus
                    maxLength={40}
                    aria-label="档案名称"
                    onChange={(event) => setEditLabel(event.target.value)}
                    onBlur={() => commitRename(account.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    className="profile-row__name"
                    onClick={() => onActivate(account.id)}
                    title={isActive ? '当前档案' : `切换到 ${account.label}`}
                  >
                    <span className="profile-row__label">{account.label}</span>
                    <span className="profile-row__meta">
                      {providerOf(account.provider).name}
                      {account.createdAt ? `，创建于 ${formatDate(account.createdAt)}` : ''}
                    </span>
                  </button>
                )}

                {isActive ? (
                  <span className="profile-row__badge">
                    <Check size={13} /> 使用中
                  </span>
                ) : (
                  <button className="btn btn--small" onClick={() => onActivate(account.id)}>
                    切换
                  </button>
                )}

                <button
                  className="icon-btn"
                  onClick={() => {
                    setEditing(account.id)
                    setEditLabel(account.label)
                  }}
                  title="重命名"
                  aria-label={`重命名 ${account.label}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn profile-row__remove"
                  onClick={() => onRemove(account.id)}
                  disabled={accounts.length <= 1}
                  title={accounts.length <= 1 ? '至少要保留一个档案' : '删除这个档案'}
                  aria-label={`删除档案 ${account.label}`}
                >
                  <Trash size={15} />
                </button>
              </li>
            )
          })}
        </ul>

        {/*
          The online account, per profile.
          This used to be invisible from here: the profiles screen listed local
          profiles and said nothing about the machine-wide Netease session, which
          is why the two looked like unrelated logins. Each profile now shows
          which account it is signed in as, and can be unbound on its own.
        */}
        <section className="accounts__group">
          <h2 className="accounts__heading">网易云账号</h2>
          <p className="accounts__hint">
            每个档案各自绑定一个网易云账号，切换档案就会切换在线歌单、每日推荐与云盘。
            登录要在该档案为当前档案时进行。
          </p>
          <ul className="binding-rows">
            {accounts.map((account) => {
              const bound = bindings[account.id]
              return (
                <li className="binding-row" key={account.id}>
                  <span className="binding-row__profile">{account.label}</span>
                  {bound ? (
                    <>
                      <span className="binding-row__account">
                        {bound.nickname}
                        {bound.vip ? ' · 会员' : ''}
                      </span>
                      <button className="btn btn--small" onClick={() => onUnbindOnline(account.id)}>
                        解除绑定
                      </button>
                    </>
                  ) : (
                    <span className="binding-row__empty">
                      {account.id === activeId ? '未登录（点侧栏的登录，或这里的登录）' : '未绑定'}
                      {account.id === activeId ? null : '——切到此档案后登录'}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <form
          className="accounts__new"
          onSubmit={(event) => {
            event.preventDefault()
            commitNew()
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="新档案的名字，比如「客厅」"
            aria-label="新档案的名字"
            maxLength={40}
          />
          <button className="btn" type="submit" disabled={!draft.trim()}>
            <Plus size={15} />
            新建档案
          </button>
        </form>
      </section>
    </div>
  )
}
