---
name: zyvro-skill-writing
description: How to write an effective SKILL.md for a Zyvro plugin — frontmatter, a description that triggers at the right time, and instructions an agent can follow. Use when writing or improving a skill inside a Zyvro plugin.
---

# Writing a skill for a Zyvro plugin

A skill is read by an AI agent in the middle of a task. Write it for that
reader: someone capable who has never seen this project and needs to act now.

## Frontmatter

```markdown
---
name: release-notes-style
description: House style and structure for release notes, from a git log to a published changelog entry. Use when writing or editing release notes.
---
```

- `name`: same as the folder name, lowercase with dashes.
- `description`: one or two sentences, up to about 300 characters. First what
  the skill gives, then **when to use it** ("Use when …"). The agent picks a
  skill from the catalog by this text alone, so name the concrete situations
  and words a user would type. Vague descriptions ("helps with code") are
  never picked; over-broad ones are picked for the wrong tasks.

## Body

Structure that works:

1. **Goal** in one or two sentences.
2. **Steps** in order, numbered, each one an action ("Run `git log
   --oneline <last-tag>..HEAD`", "Group the commits by …").
3. **Rules and checks**: what must always or never happen, as a short list.
4. **Output**: the exact format to produce, with a small example.
5. **Pitfalls**: the mistakes you would expect, and what to do instead.

Guidelines:

- Be concrete: commands, file names, formats, examples. An example beats a
  paragraph of description.
- Say why when a rule is surprising; the agent applies a rule better when it
  knows the reason.
- Keep one skill under about 300 lines. Move long reference material (a full
  style guide, a list of patterns) into another `.md` file in the same skill
  folder and link to it by relative name: "See `patterns.md` in this folder."
  The agent resolves references relative to the SKILL.md.
- Do not tell the agent to install software, spend money, publish, commit or
  change permissions unless that is the explicit purpose of the action and the
  user asked for it. Skills never grant extra authority.
- Do not write instructions aimed at hiding things from the user, bypassing
  safeguards, or overriding the user's own instructions. The store is public
  and people read skills before installing.
- Write in the language the plugin's users will use; English is the default
  for the store.

## Checklist before moving on

- Frontmatter has both `name` and `description`, between `---` lines, at the
  very top of the file.
- The description says when to use the skill.
- Every step is something the agent can actually do with its tools.
- Referenced files exist in the same skill folder and end in `.md`.
