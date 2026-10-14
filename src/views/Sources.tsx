import { Folder, Plus, Trash, Wave } from '../ui/icons'
import { SOURCES } from '../features/library/source'

interface SourcesProps {
  roots: string[]
  busy: boolean
  onAdd(): Promise<void>
  onRemove(root: string): Promise<void>
}

export function Sources({ roots, busy, onAdd, onRemove }: SourcesProps) {
  return (
    <div className="stack">
      {/*
       * What can actually play right now, read from the same registry the
       * player dispatches on. The online entry says what it is in one line -
       * a third-party reverse-engineered interface, not an official client -
       * because that is the one consequence a user has to know before using it.
       */}
      <ul className="rows">
        {SOURCES.map((source) => (
          <li className="row" key={source.id}>
            {source.online ? <Wave size={16} /> : <Folder size={16} />}
            <span className="row__path" title={source.summary}>
              {source.name}
            </span>
          </li>
        ))}
      </ul>

      {roots.length === 0 ? (
        <div className="notice">还没有加入任何文件夹</div>
      ) : (
        <ul className="rows">
          {roots.map((root) => (
            <li className="row" key={root}>
              <Folder size={16} />
              <span className="row__path" title={root}>
                {root}
              </span>
              <button
                className="icon-btn"
                onClick={() => void onRemove(root)}
                title="移出曲库"
                aria-label={`移出曲库：${root}`}
              >
                <Trash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="btn" onClick={() => void onAdd()} disabled={busy}>
        <Plus size={15} />
        添加文件夹
      </button>
    </div>
  )
}
