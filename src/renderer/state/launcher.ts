import { DEFAULT_PERMISSION, type Permission } from "../../shared/permission"
import { isAgentKind, type AgentKind } from "../../shared/harness"
import {
  EFFORTS,
  defaultProfile,
  specOfProfile,
  supportsEffort,
  type AgentProfile,
  type Effort,
  type NativeSpec,
} from "../../shared/agentShell"
import { PERMISSIONS } from "../../shared/permission"
import { getSettings } from "~/state/settings"
import { askAgent } from "~/state/persistent"
import { useWorkspace } from "~/state/workspace"

// Le lanceur d'agents du panneau Shell + Agents.
//
// Ce qu'on a réglé la dernière fois — harnais, modèle, permission, effort —
// reste réglé : lancer trois agents de suite sur la même configuration ne doit
// pas demander de la refaire trois fois. La tâche, elle, ne se retient pas
// d'une fenêtre à l'autre : un brouillon d'hier n'est pas un brouillon.
//
// Dans le stockage de la fenêtre, comme la permission : un confort de la
// personne devant cet écran, pas une donnée du projet.

export type LauncherState = {
  open: boolean
  profileId: string | null
  kind: AgentKind
  model: string | null
  permission: Permission
  effort: Effort | null
  instructions: string
  mcp: boolean
  skills: boolean
  name: string
}

const KEY = "zyvro.launcher"

function fromProfile(profile: AgentProfile): Omit<LauncherState, "open" | "name"> {
  return {
    profileId: profile.id,
    kind: profile.kind,
    model: profile.model,
    permission: profile.permission,
    effort: profile.effort,
    instructions: profile.instructions,
    mcp: profile.mcp,
    skills: profile.skills,
  }
}

/** Le profil que le lanceur propose en premier. */
export function startingProfile(): AgentProfile {
  const { profiles, defaultProfile: wanted } = getSettings().agent
  return profiles.find((p) => p.id === wanted) ?? profiles[0] ?? defaultProfile(getSettings().agent.defaultKind)
}

function clean(raw: unknown): LauncherState {
  const base = fromProfile(startingProfile())
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const kind = isAgentKind(r.kind) ? r.kind : base.kind
  return {
    open: r.open === true,
    profileId: typeof r.profileId === "string" ? r.profileId : base.profileId,
    kind,
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : isAgentKind(r.kind) ? null : base.model,
    permission: (PERMISSIONS as readonly string[]).includes(r.permission as string) ? (r.permission as Permission) : DEFAULT_PERMISSION,
    effort: supportsEffort(kind) && (EFFORTS as readonly string[]).includes(r.effort as string) ? (r.effort as Effort) : null,
    instructions: typeof r.instructions === "string" ? r.instructions.slice(0, 8000) : "",
    mcp: r.mcp !== false,
    skills: r.skills === true,
    name: "",
  }
}

function read(): LauncherState {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? clean(JSON.parse(raw)) : { ...clean({}), ...fromProfile(startingProfile()) }
  } catch {
    return clean({})
  }
}

let state: LauncherState = read()
const listeners = new Set<() => void>()

export function getLauncher(): LauncherState {
  return state
}

export function subscribeLauncher(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLauncher(patch: Partial<LauncherState>): void {
  const merged = { ...state, ...patch }
  // L'effort suit le harnais : changer pour un harnais qui n'en prend pas le
  // retire, au lieu de le garder caché et de le renvoyer plus tard.
  state = { ...merged, effort: supportsEffort(merged.kind) ? merged.effort : null }
  try {
    const { name: _name, ...kept } = state
    window.localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    // Se souvenir est un confort.
  }
  for (const listener of listeners) listener()
}

/** Charger une configuration enregistrée dans le lanceur. */
export function applyProfile(profile: AgentProfile): void {
  setLauncher(fromProfile(profile))
}

/** Montrer le lanceur (et le panneau qui le porte), la tâche prête à être écrite. */
export function openLauncher(): void {
  useWorkspace.getState().setPanel("terminal", true)
  setLauncher({ open: true })
}

/** La demande que le lanceur enverrait, pour la tâche donnée. */
export function launcherSpec(prompt: string): NativeSpec {
  return {
    kind: state.kind,
    model: state.model,
    permission: state.permission,
    effort: state.effort,
    instructions: state.instructions,
    mcp: state.mcp,
    skills: state.skills,
    name: state.name.trim(),
    prompt,
    profileId: state.profileId,
    resume: null,
    conversation: null,
    submit: false,
  }
}

/**
 * Lancer avec la configuration du lanceur : le harnais s'ouvre sur son invite,
 * c'est lui qui reçoit la tâche.
 */
export function runLauncher(): void {
  useWorkspace.getState().setPanel("terminal", true)
  askAgent(launcherSpec(""))
  setLauncher({ name: "" })
}

/** Ouvrir directement un profil, sans passer par le lanceur. */
export function runProfile(profile: AgentProfile, prompt = ""): void {
  useWorkspace.getState().setPanel("terminal", true)
  askAgent(specOfProfile(profile, prompt))
}
