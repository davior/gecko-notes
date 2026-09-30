/**
 * The folder-tree name filter keeps every match plus the path from the root down to it,
 * and nothing else — a match's siblings and unrelated branches disappear.
 */

import { describe, expect, it } from 'vitest'
import type { Folder } from '@/api/folders'
import { buildForest, folderFilterIds, folderMenuTarget, indexById, pruneForest } from './folderTree'

function folder(id: string, name: string, parent: string | null = null, extra: Partial<Folder> = {}): Folder {
  return {
    id, name, parent_folder_id: parent, sort_order: 0, icon_type: null, icon_value: null,
    color: null, system_key: null, search_query: null, created_at: '', modified_at: '', ...extra,
  }
}

//  Work
//   ├─ Projects
//   │   └─ Alpha
//   └─ Meetings
//  Personal
//   └─ Recipes
//  Archive Bin (system)
//   └─ Old Alpha
const folders = [
  folder('work', 'Work'),
  folder('projects', 'Projects', 'work'),
  folder('alpha', 'Alpha', 'projects'),
  folder('meetings', 'Meetings', 'work'),
  folder('personal', 'Personal'),
  folder('recipes', 'Recipes', 'personal'),
  folder('bin', 'Archive Bin', null, { system_key: 'archive' }),
  folder('old', 'Old Alpha', 'bin'),
]

describe('folderFilterIds', () => {
  it('returns null (no filtering) for a blank query', () => {
    expect(folderFilterIds(folders, '')).toBeNull()
    expect(folderFilterIds(folders, '   ')).toBeNull()
  })

  it('keeps matches and every ancestor, but not siblings or other branches', () => {
    const keep = folderFilterIds(folders, 'alpha')!
    expect([...keep].sort()).toEqual(['alpha', 'bin', 'old', 'projects', 'work'])
  })

  it('matches case-insensitively and by substring', () => {
    expect([...folderFilterIds(folders, 'REC')!]).toEqual(['recipes', 'personal'])
  })

  it('keeps a matching parent without pulling in its non-matching children', () => {
    const keep = folderFilterIds(folders, 'work')!
    expect([...keep]).toEqual(['work'])
  })

  it('is empty when nothing matches', () => {
    expect(folderFilterIds(folders, 'zzz')!.size).toBe(0)
  })
})

describe('pruneForest', () => {
  it('leaves only the kept branches', () => {
    const pruned = pruneForest(buildForest(folders), folderFilterIds(folders, 'alpha')!)
    const shape = (nodes: ReturnType<typeof buildForest>): unknown[] =>
      nodes.map((n) => [n.folder.id, shape(n.children)])
    // Equal sort_order, so siblings fall back to name order: "Archive Bin" before "Work".
    expect(shape(pruned)).toEqual([
      ['bin', [['old', []]]],
      ['work', [['projects', [['alpha', []]]]]],
    ])
  })
})

describe('folderMenuTarget', () => {
  const byId = indexById(folders)

  it('classifies the bin, things inside it, saved searches and ordinary folders', () => {
    expect(folderMenuTarget(byId.get('bin')!, 'bin', byId).kind).toBe('bin')
    expect(folderMenuTarget(byId.get('old')!, 'bin', byId).kind).toBe('archived')
    expect(folderMenuTarget(folder('dyn', 'Saved', null, { search_query: 'tag:x' }), 'bin', byId).kind).toBe('dynamic')
    expect(folderMenuTarget(byId.get('alpha')!, 'bin', byId).kind).toBe('normal')
  })
})
