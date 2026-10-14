import { useState } from 'react'
import type { FolderNode } from '../features/library/tree'
import { ChevronRight, Folder, Note, Play } from '../ui/icons'

interface FolderTreeProps {
  nodes: FolderNode[]
  currentFolder: string | null
  onPlay(folderPath: string, trackCount: number): void
}

interface RowProps {
  node: FolderNode
  depth: number
  currentFolder: string | null
  expanded: Set<string>
  onToggle(path: string): void
  onPlay(folderPath: string, trackCount: number): void
}

function Row({ node, depth, currentFolder, expanded, onToggle, onPlay }: RowProps) {
  const isOpen = expanded.has(node.path)
  const hasChildren = node.children.length > 0
  const isEmpty = node.totalCount === 0
  const isCurrent = currentFolder === node.path

  return (
    <>
      <div
        className={`fld${isCurrent ? ' is-current' : ''}${isEmpty ? ' is-empty' : ''}`}
        style={{ paddingLeft: `calc(var(--s2) + ${depth * 16}px)` }}
      >
        <button
          className={`fld__twist${isOpen ? ' is-open' : ''}`}
          onClick={() => hasChildren && onToggle(node.path)}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? isOpen : undefined}
          aria-label={hasChildren ? (isOpen ? '收起' : '展开') : '没有子文件夹'}
        >
          {hasChildren ? <ChevronRight size={14} /> : null}
        </button>

        <Folder size={15} />
        <span className="fld__name" title={node.path}>
          {node.name}
        </span>

        <span className="fld__count tnum">
          {node.totalCount}
          {node.directCount > 0 && node.directCount !== node.totalCount ? (
            <span className="fld__count-sub">（本级 {node.directCount}）</span>
          ) : null}
        </span>

        <button
          className="icon-btn fld__play"
          onClick={() => onPlay(node.path, node.totalCount)}
          disabled={node.totalCount === 0}
          title={`播放这个文件夹里的 ${node.totalCount} 首`}
          aria-label={`播放文件夹 ${node.name}`}
        >
          <Play size={14} />
        </button>
      </div>

      {isOpen
        ? node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              currentFolder={currentFolder}
              expanded={expanded}
              onToggle={onToggle}
              onPlay={onPlay}
            />
          ))
        : null}
    </>
  )
}

export function FolderTree({ nodes, currentFolder, onPlay }: FolderTreeProps) {
  // Roots start open: the top level of a music library is almost never what you
  // want collapsed, and an all-collapsed tree reads as an empty screen.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.map((node) => node.path))
  )

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (nodes.length === 0) {
    return (
      <div className="tracks__empty">
        <Note size={18} />
        曲库里还没有文件，所以没有目录可以浏览
      </div>
    )
  }

  return (
    <div className="folders">
      {nodes.map((node) => (
        <Row
          key={node.path}
          node={node}
          depth={0}
          currentFolder={currentFolder}
          expanded={expanded}
          onToggle={toggle}
          onPlay={onPlay}
        />
      ))}
    </div>
  )
}
