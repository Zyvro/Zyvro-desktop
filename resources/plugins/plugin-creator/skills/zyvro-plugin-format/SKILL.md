---
name: zyvro-plugin-format
description: The exact file layout and zyvro-plugin.json schema of a Zyvro Studio agent plugin, with every rule Studio and the store enforce. Use when writing or fixing the files of a Zyvro plugin.
---

# Zyvro agent plugin format (v1)

A Zyvro agent plugin is a folder of text files. It contains **no executable
code**: no JavaScript, no Lua, no scripts. It has two kinds of contributions:

- **Actions**: buttons in the chat's side bar. Clicking one sends a prepared
  request to the agent, in a new conversation, optionally after asking the user
  one question.
- **Skills**: Markdown instructions (`SKILL.md`) the agent reads. They are added
  to Zyvro's skill catalog while the plugin is on, and an action can make the
  agent read all of them before starting.

Everything a plugin does goes through the agent, under the user's permission
level. If the idea needs something the agent cannot do with its usual tools,
the plugin cannot do it either; say so instead of pretending.

## Where it lives

```
<project>/.zyvro/plugins/<name>/
  zyvro-plugin.json              required
  README.md                      optional
  skills/<skill-dir>/SKILL.md    one folder per skill
  skills/<skill-dir>/<file>.md   optional reference files for that skill
```

The folder name must equal `name` in the manifest. Studio reloads the project's
plugins after every agent turn, so a plugin written here appears in the side
bar and in Settings › Plugins without restarting.

## Files: the only ones allowed

- `zyvro-plugin.json`
- `README.md`
- `skills/<dir>/<file>.md` where `<dir>` matches `^[a-z0-9][a-z0-9-]{0,63}$`
  and `<file>` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$`.
  Exactly one level under the skill folder: no `skills/a/b/c.md`.

Anything else (an image, a `.js`, a `notes.txt`, a sub-folder) makes the whole
plugin fail to load. Hidden files such as `.DS_Store` are ignored. Symbolic
links are refused.

Limits: 64 files, 256 KiB per file, 1 MiB in total, UTF-8 text.
Every `skills/<dir>/` must contain a `SKILL.md`. A plugin needs at least one
action or one skill.

## zyvro-plugin.json

```json
{
  "name": "commit-reviewer",
  "version": "1.0.0",
  "description": "Reviews your changes before you commit.",
  "author": "Your name",
  "icon": "bug",
  "actions": [
    {
      "id": "review",
      "label": "Review my changes",
      "description": "Checks the uncommitted diff for bugs and security issues.",
      "prompt": "Review the uncommitted changes in this project ...",
      "skills": "all"
    },
    {
      "id": "focus",
      "label": "Review with a focus",
      "input": { "label": "What should the review focus on?", "placeholder": "e.g. SQL injection" },
      "prompt": "Review the uncommitted changes, focusing on: {{input}}",
      "skills": "all"
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `name` | required, `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase, digits, dashes) |
| `version` | required, `MAJOR.MINOR.PATCH`, optional `-suffix`: `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$` |
| `description` | optional, up to 500 characters; shown in the store and settings |
| `author` | optional, up to 100 characters |
| `icon` | optional, one of `puzzle sparkles wand book bug rocket code pen` (default `puzzle`) |
| `actions` | optional list, at most 8 |

Each action:

| Field | Rule |
| --- | --- |
| `id` | required, `^[a-z0-9][a-z0-9-]{0,31}$`, unique in the plugin |
| `label` | required, 1 to 60 characters; the button's name |
| `description` | optional, up to 200 characters |
| `input` | optional object `{ "label": 1–100 chars, "placeholder": up to 200 }`: Studio asks the user this before running |
| `prompt` | required, 1 to 8000 characters: the request sent to the agent |
| `skills` | optional, `"all"` (default) or `"none"` |

Rules that are easy to miss:

- **`{{input}}`**: if the action has an `input`, its `prompt` must contain
  `{{input}}` (replaced by the user's answer). If it has no `input`, the prompt
  must not contain `{{input}}`.
- **Unknown keys are refused** everywhere (top level, actions, input). A typo
  such as `"action"` or `"promt"` makes the plugin fail to load, on purpose.
- `null` counts as absent for optional fields. A wrong type (a number for
  `label`) is refused.
- With `"skills": "all"`, Studio puts the list of the plugin's skill files in
  front of the prompt and tells the agent to read all of them first. Use
  `"none"` for a quick action that does not need them.
- Values are trimmed; lengths count characters, not bytes.

## SKILL.md

```markdown
---
name: commit-review-checklist
description: What to check when reviewing a diff for bugs and security issues. Use when reviewing uncommitted changes.
---

# Commit review checklist
...
```

`name` and `description` are required in the frontmatter (between the two
`---` lines). The description is what decides when the skill is picked from
the catalog, so it says what the skill does and when to use it. See the
zyvro-skill-writing skill.

## Versions are immutable once published

The store never lets a `name@version` change. After a publish, any change needs
a new `version` (see zyvro-plugin-publishing).
