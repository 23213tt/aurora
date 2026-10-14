import { ChevronLeft, ChevronRight, Mark, Search } from '../ui/icons'

interface TitleBarProps {
  query: string
  onQuery: (query: string) => void
  onBack: () => void
  onForward: () => void
  canBack: boolean
  canForward: boolean
}

export function TitleBar({
  query,
  onQuery,
  onBack,
  onForward,
  canBack,
  canForward
}: TitleBarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar__mark">
        <Mark size={17} />
        <span>Aurora</span>
      </div>

      <div className="titlebar__history">
        <button
          className="icon-btn"
          onClick={onBack}
          disabled={!canBack}
          title="后退"
          aria-label="后退"
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onForward}
          disabled={!canForward}
          title="前进"
          aria-label="前进"
        >
          <ChevronRight size={17} />
        </button>
      </div>

      <label className="search">
        <Search size={15} />
        <input
          id="global-search"
          type="search"
          value={query}
          placeholder="搜索歌曲、专辑、艺术家"
          aria-label="搜索曲库"
          onChange={(event) => onQuery(event.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </label>

      <div className="titlebar__spacer" />
    </header>
  )
}
