import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
/*
 * Explicit `.ts` extension: tests import this module directly and run under
 * Node, whose ESM resolver does not guess extensions the way Vite does. Dropping
 * it breaks `npm test` (see tests/profile-isolation.test.ts) while still building
 * fine, so it looks like a typo and is not one.
 */
import { createProfileScopedStorage, setActiveStorageProfile } from '../accounts/profile-storage.ts'
export interface Playlist {
  id: string
  name: string
  /** Track ids, in playlist order. The library owns the track data itself. */
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

interface PlaylistsState {
  playlists: Playlist[]
  create(name: string, trackIds?: string[]): Playlist
  rename(id: string, name: string): void
  remove(id: string): void
  /** Returns how many ids were actually appended (duplicates are kept). */
  addTracks(id: string, trackIds: string[], at?: number): number
  removeAt(id: string, index: number): void
  removeIds(id: string, trackIds: string[]): void
  move(id: string, from: number, to: number): void
  replaceTracks(id: string, trackIds: string[]): void
}

function newId(): string {
  return `pl_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export const usePlaylists = create<PlaylistsState>()(
  persist(
    (set) => {
      const touch = (playlists: Playlist[], id: string, patch: Partial<Playlist>): Playlist[] =>
        playlists.map((playlist) =>
          playlist.id === id ? { ...playlist, ...patch, updatedAt: Date.now() } : playlist
        )

      return {
        playlists: [],

        create(name, trackIds = []) {
          const playlist: Playlist = {
            id: newId(),
            name: name.trim() || '新建播放列表',
            trackIds: [...trackIds],
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
          set((state) => ({ playlists: [...state.playlists, playlist] }))
          return playlist
        },

        rename(id, name) {
          const clean = name.trim()
          if (!clean) return
          set((state) => ({ playlists: touch(state.playlists, id, { name: clean }) }))
        },

        remove(id) {
          set((state) => ({ playlists: state.playlists.filter((playlist) => playlist.id !== id) }))
        },

        addTracks(id, trackIds, at) {
          if (trackIds.length === 0) return 0
          set((state) => ({
            playlists: state.playlists.map((playlist) => {
              if (playlist.id !== id) return playlist
              const next = [...playlist.trackIds]
              const index = at === undefined ? next.length : Math.min(Math.max(0, at), next.length)
              next.splice(index, 0, ...trackIds)
              return { ...playlist, trackIds: next, updatedAt: Date.now() }
            })
          }))
          return trackIds.length
        },

        removeAt(id, index) {
          set((state) => ({
            playlists: state.playlists.map((playlist) =>
              playlist.id === id
                ? {
                    ...playlist,
                    trackIds: playlist.trackIds.filter((_, i) => i !== index),
                    updatedAt: Date.now()
                  }
                : playlist
            )
          }))
        },

        removeIds(id, trackIds) {
          const drop = new Set(trackIds)
          set((state) => ({
            playlists: state.playlists.map((playlist) =>
              playlist.id === id
                ? {
                    ...playlist,
                    trackIds: playlist.trackIds.filter((trackId) => !drop.has(trackId)),
                    updatedAt: Date.now()
                  }
                : playlist
            )
          }))
        },

        move(id, from, to) {
          set((state) => ({
            playlists: state.playlists.map((playlist) => {
              if (playlist.id !== id) return playlist
              const next = [...playlist.trackIds]
              if (from < 0 || from >= next.length) return playlist
              const target = Math.min(Math.max(0, to), next.length - 1)
              if (from === target) return playlist
              const [moved] = next.splice(from, 1)
              next.splice(target, 0, moved)
              return { ...playlist, trackIds: next, updatedAt: Date.now() }
            })
          }))
        },

        replaceTracks(id, trackIds) {
          set((state) => ({ playlists: touch(state.playlists, id, { trackIds: [...trackIds] }) }))
        }
      }
    },
    {
      name: 'aurora.playlists',
      version: 1,
      // Keyed by the active profile, so each profile keeps its own library.
      storage: createJSONStorage(createProfileScopedStorage)
    }
  )
)

/**
 * Point the playlists store at a profile and load that profile's playlists.
 *
 * Order matters here, because zustand's persist middleware writes to storage on
 * *every* state change - including a change made to clear the state.
 *
 * So the slot is read first. Only when it genuinely holds nothing is the state
 * reset, and that reset is then safe to persist because there is nothing to
 * lose. Clearing first and rehydrating second would write an empty array over
 * the profile's saved playlists before the rehydrate could read them.
 */
export async function loadProfilePlaylists(profileId: string | null): Promise<void> {
  setActiveStorageProfile(profileId)

  const stored = createProfileScopedStorage().getItem('aurora.playlists')
  if (stored === null) {
    usePlaylists.setState({ playlists: [] })
    return
  }

  await usePlaylists.persist.rehydrate()
}
