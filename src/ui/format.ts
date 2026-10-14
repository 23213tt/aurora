/**
 * Seconds to a clock string: `3:07`, or `1:02:03` once there is an hour.
 *
 * Lives in `ui/` rather than next to the progress bar because the track list, the
 * queue and the playlist screen all need it. Keeping it on the player component
 * made those views reach into `features/` for a string formatter, which is
 * backwards: a primitive should not depend on a feature.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
