import { useState, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import type { AgentQuestion, QuestionAnswers } from "../../shared/questions"

// QuestionCard : les questions de l'agent, et le bouton qui envoie.
//
// Claude (AskUserQuestion) et Codex (request_user_input) arrivent ici dans la
// même forme (shared/questions.ts). Une à quatre questions ; pour chacune, des
// options à cliquer — une seule, ou plusieurs quand la question le dit — et un
// champ « Autre » quand on peut répondre hors des options. On envoie quand
// toutes ont une réponse : une question laissée vide, l'agent la relirait comme
// un refus.
//
// « Skip » refuse de répondre : l'agent l'apprend et continue sans.

type Draft = { picked: string[]; other: string }

function answerOf(q: AgentQuestion, draft: Draft): string[] {
  const other = draft.other.trim()
  if (q.multiSelect) return other ? [...draft.picked, other] : draft.picked
  return other ? [other] : draft.picked.slice(0, 1)
}

export function QuestionCard({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: AgentQuestion[]
  onSubmit: (answers: QuestionAnswers) => void
  onSkip: () => void
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const draftOf = (q: AgentQuestion): Draft => drafts[q.id] ?? { picked: [], other: "" }
  const update = (q: AgentQuestion, next: Draft) => setDrafts((all) => ({ ...all, [q.id]: next }))

  const pick = (q: AgentQuestion, label: string) => {
    const draft = draftOf(q)
    if (q.multiSelect) {
      const picked = draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label]
      update(q, { ...draft, picked })
    } else {
      // Un seul choix : une option efface ce qu'on avait écrit dans « Autre ».
      update(q, { picked: [label], other: "" })
    }
  }
  const write = (q: AgentQuestion, other: string) => {
    const draft = draftOf(q)
    // Et inversement : écrire sa propre réponse retire l'option choisie.
    update(q, q.multiSelect ? { ...draft, other } : { picked: other.trim() ? [] : draft.picked, other })
  }

  const complete = questions.every((q) => answerOf(q, draftOf(q)).length > 0)
  const submit = () => {
    if (!complete) return
    const answers: QuestionAnswers = {}
    for (const q of questions) answers[q.id] = answerOf(q, draftOf(q))
    onSubmit(answers)
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="mb-1.5 rounded-lg border border-sky-400/30 bg-sky-400/[0.06] p-2.5">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-sky-200/70">
        {questions.length > 1 ? "The agent has questions" : "The agent has a question"}
      </div>
      <div className="flex flex-col gap-2.5">
        {questions.map((q) => {
          const draft = draftOf(q)
          return (
            <div key={q.id}>
              <div className="flex items-baseline gap-2">
                {q.header && (
                  <span className="shrink-0 rounded bg-sky-400/15 px-1.5 py-px text-[10px] font-medium text-sky-200">{q.header}</span>
                )}
                <span className="text-[12px] text-foreground">{q.question}</span>
              </div>
              {q.multiSelect && <div className="mt-0.5 text-[10px] text-muted-foreground">Several answers allowed.</div>}
              {q.options.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {q.options.map((option) => {
                    const on = draft.picked.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => pick(q, option.label)}
                        className={cn(
                          "flex items-start gap-2 rounded-md border px-2 py-1 text-left",
                          on ? "border-sky-400/60 bg-sky-400/15" : "border-white/[0.08] hover:bg-white/[0.05]"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-[3px] h-2.5 w-2.5 shrink-0 border",
                            q.multiSelect ? "rounded-sm" : "rounded-full",
                            on ? "border-sky-300 bg-sky-300" : "border-white/30"
                          )}
                        />
                        <span className="min-w-0">
                          <span className="block text-[12px] text-foreground">{option.label}</span>
                          {option.description && <span className="block text-[11px] leading-snug text-muted-foreground">{option.description}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {q.other && (
                <input
                  type={q.secret ? "password" : "text"}
                  value={draft.other}
                  onChange={(event) => write(q, event.target.value)}
                  onKeyDown={onKey}
                  placeholder={q.options.length > 0 ? "Other…" : "Your answer…"}
                  className="mt-1.5 w-full rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:border-sky-400/50 focus:outline-none"
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={!complete}
          onClick={submit}
          className="rounded-md bg-sky-400/90 px-2.5 py-1 text-[12px] font-medium text-black hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md border border-white/[0.12] px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          Skip
        </button>
      </div>
    </div>
  )
}
