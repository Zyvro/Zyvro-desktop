---
name: zyvro-plugin-publishing
description: How a Zyvro agent plugin is published to the Zyvro store and updated afterwards — signing, immutable versions, and what the user must do themselves. Use when the user wants to publish, update or withdraw a Zyvro plugin.
---

# Publishing a Zyvro plugin

Publishing is the user's act, not the agent's. It puts the plugin in a public
store under their account, signed with their key, and needs their account
password. Never publish on your own initiative and never ask for the password:
explain the steps and let them click.

## Before publishing

- The plugin loads in Studio (see zyvro-plugin-testing): a plugin that does
  not load cannot be published, and Store › Publish shows why.
- `description` in `zyvro-plugin.json` says clearly what the plugin does; it
  is the first thing people read in the store.
- A `README.md` helps people decide; it is shown with the files.
- Re-read the skills as a stranger would: they are public, and people read
  them before installing.

## Steps for the user

1. Sign in to Zyvro in Studio (Store › Sign in to publish) if not already.
2. Open **Store › Publish**. The plugin is listed under **Agent plugins in
   this project**.
3. Click **Publish** and enter the account password. It unlocks the signing
   key on this machine for this sitting only; the first publish creates the
   key.

The store checks the plugin with the same rules as Studio, computes its
digest, verifies the signature, and lists it in **Store › Plugins** and on
zyv.ro/store.

## Names and versions

- The first account to publish a name owns it; nobody else can publish under
  it.
- A published `name@version` never changes. To ship a change, raise `version`
  in `zyvro-plugin.json` (`1.0.0` → `1.0.1` for fixes, `1.1.0` for new actions
  or skills, `2.0.0` when existing actions change meaning), then publish again.
- Installed copies do not update by themselves: users see "Update from
  <version>" in the store.

## Withdrawing

A published version can be yanked by its publisher: it disappears from
listings, but anyone who installed it keeps it. Yanking is done on the store
(API `DELETE /api/store/plugins/<name>/<version>`); there is no button in
Studio yet, so tell the user that if they ask.
