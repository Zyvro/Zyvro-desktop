---
name: zyvro-plugin-testing
description: How to verify a Zyvro agent plugin before handing it over — every format rule checked file by file, then confirmation that Zyvro Studio loaded it. Use after writing or changing a Zyvro plugin.
---

# Testing a Zyvro plugin

A plugin that breaks one rule does not load at all, and Studio shows the
reason in Settings › Plugins (and in Store › Publish) rather than in the chat.
So check the rules yourself before saying it is done.

## 1. Check the files

List the plugin folder (`.zyvro/plugins/<name>/`, including hidden files) and
confirm:

- Only `zyvro-plugin.json`, `README.md` and `skills/<dir>/<file>.md` exist.
  Delete anything else you created (drafts, `.txt`, images). Hidden files such
  as `.DS_Store` are ignored, but do not create any.
- No sub-folder deeper than `skills/<dir>/`.
- The folder name equals `name` in the manifest.
- Every `skills/<dir>/` has a `SKILL.md`, and each one starts with frontmatter
  holding a non-empty `name` and `description`.

## 2. Check the manifest

Parse `zyvro-plugin.json` with a real JSON parser, for example:

```sh
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("valid JSON")' .zyvro/plugins/<name>/zyvro-plugin.json
```

(or `python3 -m json.tool <file>`). Then check by reading it:

- Only the keys `name version description author icon actions` at the top;
  only `id label description input prompt skills` in an action; only
  `label placeholder` in `input`.
- `name` and every action `id` are lowercase letters, digits and dashes.
- `version` looks like `1.0.0`.
- `icon`, if set, is one of `puzzle sparkles wand book bug rocket code pen`.
- At most 8 actions, ids unique, labels 60 characters or fewer.
- An action with `input` has `{{input}}` in its prompt; an action without
  `input` does not.
- `skills` is `"all"` or `"none"` if set.

## 3. Confirm Studio loaded it

Studio re-reads the project's plugins when your turn ends. Tell the user where
to look rather than claiming success you cannot see:

- **Settings › Plugins › Installed plugins** lists it with the tag "This
  project", or shows it under the list with "Not loaded:" and the reason.
- Its icon appears in the chat's right-hand bar when it has actions.

If the Zyvro app tools are available in this session (for example a tool that
reads Studio's window), you may use them to look at Settings › Plugins
yourself. Do not click the plugin's actions to test them unless the user asks:
each one starts an agent turn on their account.

## 4. Dry-run the prompts

Read each action's prompt as if you received it with no other context, with a
realistic `{{input}}` substituted. It should be clear what to do, on what, and
what to produce. Fix anything ambiguous.

## 5. Report

Tell the user: the plugin's folder, its actions (and what each asks), its
skills, anything you chose on their behalf, and how to try it. Then point to
publishing (zyvro-plugin-publishing) without doing it.
