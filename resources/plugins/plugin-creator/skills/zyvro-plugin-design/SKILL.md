---
name: zyvro-plugin-design
description: Turn a plugin idea into a Zyvro agent plugin design — name, actions, skills and their boundaries — before writing any file. Use first when creating or reshaping a Zyvro plugin.
---

# Designing a Zyvro plugin from an idea

Design on paper first; files come after. The result of this step is a short
plan you state to the user in a few lines: the name, each action with its
label and whether it asks a question, and each skill with one sentence on what
it teaches.

## 1. Understand what the user wants to happen

Restate the idea as: *who clicks what, and what the agent then does*. A plugin
is "a button that makes the agent do X well, every time". If the idea is a
behaviour with no clear trigger, it is probably a skill with no action.

Ask one short question only if the answer changes what you build (for example,
"review before each commit, or on demand?"). Otherwise choose and say what you
chose.

## 2. Check that it is possible

A plugin has no code. It works only through the agent, with the tools the
agent already has and the user's permission level. Fine: reviewing files,
writing docs, refactoring, running the project's commands, calling the Zyvro
MCP tools, researching. Not possible: a new UI panel, a background service, a
timer of its own, reading the screen, anything the agent itself cannot do. If
part of the idea is impossible, say which part and design the closest thing
that works.

## 3. Choose the actions (0 to 8, usually 1 to 3)

- One action per distinct thing the user would click. Do not split one job
  into steps the user has to click in order.
- Give an action an `input` only when the request genuinely depends on the
  user's words (a topic, a file, a goal). Write the input label as the
  question, and the placeholder as a concrete example.
- Labels are short verbs: "Review my changes", "Write release notes".
- The prompt is a complete, self-contained request: what to do, on what, what
  to produce, and what *not* to do (no commits, no publishing, no paid runs)
  unless the user asked. Reference the skills by name.

## 4. Choose the skills

Put durable know-how in skills and keep prompts short. A skill is right for:
a checklist, a house style, a procedure with steps, domain knowledge, output
formats. Rules of thumb:

- One skill per topic the agent would look up separately. Two to four skills
  is typical; one is fine for a small plugin.
- Use `"skills": "all"` on actions that need the know-how, `"none"` on quick
  actions that do not.
- A plugin can be skills only (no actions): its skills join the catalog of
  "Advanced skills" and the agent picks them when relevant.

## 5. Name it

`name`: lowercase words with dashes, specific, not taken by a built-in idea
(`commit-reviewer`, `release-notes`, `i18n-checker`). Skill folder names
follow the same pattern and are prefixed with the plugin's topic so they read
well in a mixed catalog (`commit-review-checklist`). Pick the `icon` that fits
best from: puzzle, sparkles, wand, book, bug, rocket, code, pen.

## 6. State the plan, then build

Write the plan in a few lines to the user, then write the files following the
zyvro-plugin-format and zyvro-skill-writing skills, and verify with
zyvro-plugin-testing.
