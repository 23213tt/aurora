import { useState } from 'react'
import { providerOf } from '../accounts/providers'
import type { Account } from '../accounts/store'
import { Check, Pencil, Plus, Trash } from './icons'

interface AccountsViewProps {
  accounts: Account[]
  activeId: string | null
  onCreate(label: string): void
  onActivate(id: string): void
  onRename(id: string, label: string): void
  onRemove(id: string): void
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
  onRemove
}: AccountsViewProps) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

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
