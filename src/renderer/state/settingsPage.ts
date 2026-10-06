import { create } from "zustand"
import type { AgentKind } from "../../shared/harness"

export const SETTINGS_PAGES = [
  { id: "general", label: "General", hint: "Updates and configuration files" },
  { id: "editor", label: "Editor", hint: "Text, indentation and saving" },
  { id: "agents", label: "Agents", hint: "Default agent and model" },
  { id: "plugins", label: "Plugins", hint: "Agent features to turn on or off" },
  { id: "permissions", label: "Permissions", hint: "What agents can do" },
  { id: "skills", label: "Skills & packs", hint: "Installed skills and downloads" },
  { id: "appearance", label: "Appearance", hint: "Chat colors and indicators" },
  { id: "capture", label: "Capture", hint: "Screen capture and shortcuts" },
] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"]
export const useSettingsPage = create<{
  page: SettingsPage
  skillsKind: AgentKind | null
  select: (page: SettingsPage) => void
  selectSkills: (kind: AgentKind) => void
}>((set) => ({
  page: "general", skillsKind: null,
  select: (page) => set({ page }),
  selectSkills: (skillsKind) => set({ page: "skills", skillsKind }),
}))
