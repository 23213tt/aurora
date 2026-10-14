import { usePlayer } from '../features/player/store'
import { formatTime } from '../ui/Bar'
import { Close, List, Trash } from '../ui/icons'

interface QueuePanelProps {
  open: boolean
  onClose(): void
}

interface RowProps {
  trackIndex: number
  label: string
  isCurrent: boolean
  playing: boolean
  onJump(queueIndex: number): void
  onRemove(queueIndex: number): void
}

function QueueRow({
  trackIndex,
  label,
  isCurrent,
  playing,
  onJump,
  onRemove
}: RowProps) {
  const track = usePlayer((s) => s.queue[trackIndex] ?? null)
  if (!track) return null

  return (
    <li className={`queue-row${isCurrent ? ' is-current' : ''}`}>
      <button
        className="queue-row__main"
        onClick={() => onJump(trackIndex)}
        title={isCurrent ? '正在播放' : `跳到 ${track.title}`}
      >
        <span className="queue-row__label">{label}</span>
        <span className="queue-row__title">
          {isCurrent && playing ? (
            <span className="eq is-live" aria-label="正在播放">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          <span className="queue-row__title-text">{track.title || '（无标题）'}</span>
        </span>
        <span className="queue-row__artist">{track.artist}</span>
        <span className="queue-row__time tnum">{formatTime(track.duration)}</span>
      </button>

      <button
        className="icon-btn queue-row__remove"
        onClick={() => onRemove(trackIndex)}
        title="从队列里移除"
        aria-label={`从队列移除 ${track.title}`}
      >
        <Trash size={14} />
      </button>
    </li>
  )
}

/**
 * The play queue.
 *
 * Rows are rendered in *play order*, not queue order, so the list shows what
 * will actually happen next - including the shuffle permutation. Rendering the
 * raw queue while shuffle is on would show an order that never plays.
 */
export function QueuePanel({ open, onClose }: QueuePanelProps) {
  const queueLength = usePlayer((s) => s.queue.length)
  const order = usePlayer((s) => s.order)
  const index = usePlayer((s) => s.index)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const playing = usePlayer((s) => s.playing)

  if (!open) return null

  const at = order.indexOf(index)
  const upcoming = at === -1 ? [] : order.slice(at + 1)
  const played = at === -1 ? [] : order.slice(0, at)

  const jump = (queueIndex: number) => {
    const state = usePlayer.getState()
    state.jumpTo(queueIndex)
  }

  const remove = (queueIndex: number) => {
    usePlayer.getState().removeAt(queueIndex)
  }

  return (
    <aside className="panel" aria-label="播放队列">
      <header className="panel__head">
        <h2 className="panel__title">播放队列</h2>
        <span className="panel__count tnum">
          {queueLength} 首
          {shuffle ? '，随机顺序' : ''}
          {repeat === 'one' ? '，单曲循环' : repeat === 'all' ? '，列表循环' : ''}
        </span>
        <button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭播放队列">
          <Close size={16} />
        </button>
      </header>

      <div className="panel__scroll">
        {queueLength === 0 ? (
          <div className="tracks__empty">
            <List size={18} />
            队列是空的
          </div>
        ) : (
          <>
            {at >= 0 ? (
              <section className="queue-group">
                <h3 className="queue-group__title">正在播放</h3>
                <ul className="queue-list">
                  <QueueRow
                    trackIndex={index}
                    label="▶"
                    isCurrent
                    playing={playing}
                    onJump={jump}
                    onRemove={remove}
                  />
                </ul>
              </section>
            ) : null}

            <section className="queue-group">
              <h3 className="queue-group__title">
                接下来
                <span className="queue-group__count tnum">{upcoming.length}</span>
              </h3>
              {upcoming.length === 0 ? (
                <p className="queue-group__empty">队列里没有别的曲目了</p>
              ) : (
                <ul className="queue-list">
                  {upcoming.map((queueIndex, position) => (
                    <QueueRow
                      key={`${queueIndex}-${position}`}
                      trackIndex={queueIndex}
                      label={String(position + 1)}
                      isCurrent={false}
                      playing={playing}
                      onJump={jump}
                      onRemove={remove}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Native disclosure: the played list is reference material, so it
                costs no state and starts folded. */}
            {played.length > 0 ? (
              <details className="queue-played">
                <summary className="queue-group__title">
                  已播放
                  <span className="queue-group__count tnum">{played.length}</span>
                </summary>
                <ul className="queue-list">
                  {played.map((queueIndex, position) => (
                    <QueueRow
                      key={`${queueIndex}-played-${position}`}
                      trackIndex={queueIndex}
                      label="·"
                      isCurrent={false}
                      playing={false}
                      onJump={jump}
                      onRemove={remove}
                    />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}
