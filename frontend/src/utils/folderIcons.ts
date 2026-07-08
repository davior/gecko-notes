import {
  Folder, FolderOpen, Star, Heart, Briefcase, BookOpen, Archive, Tag, Image, Music, Code, Home,
  Calendar, MapPin, Users, Gift, Palette, Lightbulb, Rocket, Trophy, Wallet, Coffee, Leaf, Sun,
  Moon, Cloud, Flame, Shield, Lock, Camera, Plane, Dumbbell,
  type LucideIcon,
} from 'lucide-react'
import type { Folder as FolderType } from '@/api/folders'

// Curated set of icons offered in the folder customization picker. Keys are the
// stable names persisted to Folder.icon_value when icon_type === 'lucide'.
export const FOLDER_ICON_CATALOGUE: Record<string, LucideIcon> = {
  Folder, FolderOpen, Star, Heart, Briefcase, BookOpen, Archive, Tag, Image, Music, Code, Home,
  Calendar, MapPin, Users, Gift, Palette, Lightbulb, Rocket, Trophy, Wallet, Coffee, Leaf, Sun,
  Moon, Cloud, Flame, Shield, Lock, Camera, Plane, Dumbbell,
}

export const FOLDER_COLOR_PRESETS: string[] = [
  '#EF4444', // red
  '#F97316', // orange
  '#F59E0B', // amber
  '#84CC16', // lime
  '#10B981', // emerald
  '#14B8A6', // teal
  '#3B82F6', // blue
  '#6366F1', // indigo
  '#A855F7', // purple
  '#EC4899', // pink
]

export type ResolvedFolderIcon =
  | { kind: 'emoji'; emoji: string }
  | { kind: 'lucide'; Icon: LucideIcon }

// Falls back to the default Folder icon when the folder has no customization,
// or its icon_value is an emoji/lucide name we no longer recognise.
export function resolveFolderIcon(folder: Pick<FolderType, 'icon_type' | 'icon_value'>): ResolvedFolderIcon {
  if (folder.icon_type === 'emoji' && folder.icon_value) {
    return { kind: 'emoji', emoji: folder.icon_value }
  }
  if (folder.icon_type === 'lucide' && folder.icon_value && FOLDER_ICON_CATALOGUE[folder.icon_value]) {
    return { kind: 'lucide', Icon: FOLDER_ICON_CATALOGUE[folder.icon_value] }
  }
  return { kind: 'lucide', Icon: Folder }
}
