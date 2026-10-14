import { Plus, Refresh, Wave } from '../ui/icons'

interface EmptyLibraryProps {
  onAdd(): Promise<void>
  busy: boolean
  scanning: boolean
  roots: string[]
}

export function EmptyLibrary({ onAdd, busy, scanning, roots }: EmptyLibraryProps) {
  // Three genuinely different states, each with its own next action. Showing
  // "your library is empty" to someone whose scan is running is a lie.
  if (scanning) {
    return (
      <div className="empty">
        <div className="empty__art">
          <Wave size={30} />
        </div>
        <h2>正在读取标签</h2>
      </div>
    )
  }

  if (roots.length > 0) {
    return (
      <div className="empty">
        <div className="empty__art">
          <Refresh size={30} />
        </div>
        <h2>这些文件夹里没有找到音乐</h2>
        {/*
          Naming the folders is the whole point of this state. "Added, but there
          is nothing in it" and "adding did not work at all" look identical
          otherwise, and the second one is the conclusion people reach.
        */}
        <ul className="empty__roots">
          {roots.map((root) => (
            <li key={root} title={root}>
              {root}
            </li>
          ))}
        </ul>
        <button className="btn btn--accent" onClick={() => void onAdd()} disabled={busy}>
          <Plus size={15} />
          换个文件夹
        </button>
      </div>
    )
  }

  return (
    <div className="empty">
      <div className="empty__art">
        <Wave size={30} />
      </div>
      <h2>曲库还是空的</h2>
      <button className="btn btn--accent" onClick={() => void onAdd()} disabled={busy}>
        <Plus size={15} />
        选择音乐文件夹
      </button>
    </div>
  )
}
