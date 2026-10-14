import type { ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

/**
 * Inline icon set. Hand-rolled rather than pulled from an icon package: it is a
 * couple of kilobytes, works offline under our CSP, and keeps every glyph on one
 * grid at one stroke weight so the UI reads as a single hand.
 */
function Svg({
  size = 16,
  className,
  strokeWidth = 1.75,
  children
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Aurora ribbons, which double as a stack of waveform envelopes. */
export const Mark = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}>
    <path d="M3 8.5C7 4 17 4 21 8.5" />
    <path d="M5.5 13.5C8.5 10.5 15.5 10.5 18.5 13.5" />
    <path d="M8.5 18.5C10 17 14 17 15.5 18.5" />
  </Svg>
)

export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6 9 12l5.5 6" />
  </Svg>
)

export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 6 15 12l-5.5 6" />
  </Svg>
)

export const ChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9.5 12 15l6-5.5" />
  </Svg>
)

export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
)

export const Album = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.25" />
  </Svg>
)

export const Mic = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3Z" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Svg>
)

export const Note = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18V6.5l9-2v11" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="15.5" cy="15.5" r="2.5" />
  </Svg>
)

export const Folder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3.6a1.5 1.5 0 0 1 1.2.6l.9 1.2h8.3a1.5 1.5 0 0 1 1.5 1.5v8.2a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
  </Svg>
)

export const List = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h11M4 12h11M4 17h7" />
    <path d="M18.5 15v5" />
    <circle cx="17" cy="19.5" r="1.5" />
  </Svg>
)

export const Sliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4v6M6 14v6M12 4v3M12 11v9M18 4v10M18 18v2" />
    <circle cx="6" cy="12" r="2" />
    <circle cx="12" cy="9" r="2" />
    <circle cx="18" cy="16" r="2" />
  </Svg>
)

export const Settings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6" />
  </Svg>
)

export const Play = (p: IconProps) => (
  <Svg {...p} strokeWidth={1.5}>
    <path d="M8 5.4v13.2L19 12Z" fill="currentColor" />
  </Svg>
)

export const Pause = (p: IconProps) => (
  <Svg {...p} strokeWidth={1.5}>
    <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={2.5} />
  </Svg>
)

export const Prev = (p: IconProps) => (
  <Svg {...p} strokeWidth={1.5}>
    <path d="M18.5 6v12L9.5 12Z" fill="currentColor" />
    <path d="M6 5.5v13" strokeWidth={2.2} />
  </Svg>
)

export const Next = (p: IconProps) => (
  <Svg {...p} strokeWidth={1.5}>
    <path d="M5.5 6v12L14.5 12Z" fill="currentColor" />
    <path d="M18 5.5v13" strokeWidth={2.2} />
  </Svg>
)

export const Shuffle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 5.5 20 8.5l-3 3" />
    <path d="M20 8.5h-3.2c-1.6 0-2.4 1-3.4 2.3l-2 2.6c-1 1.3-1.8 2.1-3.4 2.1H4" />
    <path d="M17 12.5l3 3-3 3" />
    <path d="M4 8.5h3.2c1.4 0 2.2.8 3 1.9" />
    <path d="M13.6 15.4c.8 1 1.6 1.6 3.2 1.6H20" />
  </Svg>
)

export const Repeat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 5.5h9a3.5 3.5 0 0 1 3.5 3.5v1.5" />
    <path d="M9 3 6.8 5.5 9 8" />
    <path d="M17 18.5H8a3.5 3.5 0 0 1-3.5-3.5v-1.5" />
    <path d="M15 21l2.2-2.5L15 16" />
  </Svg>
)

export const RepeatOne = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 5.5h9a3.5 3.5 0 0 1 3.5 3.5v1.5" />
    <path d="M9 3 6.8 5.5 9 8" />
    <path d="M17 18.5H8a3.5 3.5 0 0 1-3.5-3.5v-1.5" />
    <path d="M15 21l2.2-2.5L15 16" />
    <path d="M11.6 11v2.2M11.6 11l-1.3.8" strokeWidth={1.6} />
  </Svg>
)

export const Volume = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4Z" />
    <path d="M14.5 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M17 7a7 7 0 0 1 0 10" />
  </Svg>
)

export const VolumeMute = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4Z" />
    <path d="m15 10 4 4M19 10l-4 4" />
  </Svg>
)

export const Lyrics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15M4.5 11.5h10M4.5 16.5h6" />
    <path d="M16 20.5a2.5 2.5 0 0 0 2.5-2.5v-4" />
    <circle cx="17" cy="12" r="1.6" />
  </Svg>
)

export const Queue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h10M4 12h10M4 17h6" />
    <path d="M20 9.5v7" />
    <path d="m20 9.5-3 1.2" />
  </Svg>
)

export const Sidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M9.5 4.5v15" />
  </Svg>
)

export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
)

export const Trash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
    <path d="M6.5 6.5 7.4 19a1.2 1.2 0 0 0 1.2 1.1h6.8a1.2 1.2 0 0 0 1.2-1.1l.9-12.5" />
    <path d="M10.5 10v6.5M13.5 10v6.5" />
  </Svg>
)

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

/** The desktop lyric strip: a floating bar of text over the desktop. */
export const DesktopLyrics = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13.5" rx="2.5" />
    <path d="M6.5 9.5h11M8.5 13.5h7" />
    <path d="M9.5 20h5" />
  </Svg>
)

export const Pencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5h3.2L18.9 8.3a1.8 1.8 0 0 0 0-2.5l-.7-.7a1.8 1.8 0 0 0-2.5 0L4.5 16.3Z" />
    <path d="M14.2 6.6l3.2 3.2" />
  </Svg>
)

export const User = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.4" r="3.6" />
    <path d="M4.6 20c0-3.7 3.3-6.1 7.4-6.1s7.4 2.4 7.4 6.1" />
  </Svg>
)

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const Lock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
  </Svg>
)

export const Unlock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.6a4 4 0 0 1 7.7-1.5" />
  </Svg>
)

export const Minus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 12h13" />
  </Svg>
)

export const Refresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20.5 4.5V10h-5.2" />
  </Svg>
)

export const Wave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h2M7 8.5v7M11 5v14M15 8v8M19 10.5v3" />
  </Svg>
)
