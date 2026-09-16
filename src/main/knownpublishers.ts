import { app } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import { fingerprint } from "./signing"

// What this machine has seen a publisher sign with.
//
// This file is the reason signing is worth anything at all. A client that
// learns a publisher's key from the store learns it from the same place it gets
// the pack, so a compromised store could hand over both and the signature would
// check out. What it cannot do is change a key this machine already wrote down.
//
// So: remember the key the first time, and say something the day it differs.
// Trust on first use — the same bargain SSH makes, and for the same reason:
// there is nothing better available without a second channel, and it turns a
// silent substitution into a question.
//
// Kept beside the account rather than inside a project: a publisher you trust
// is a fact about you, not about the folder you happen to have open.

export type KnownPublisher = {
  name: string
  publicKey: string
  firstSeen: string
}

export type PublisherVerdict =
  | { kind: "unsigned" }
  | { kind: "first-sight"; fingerprint: string }
  | { kind: "known"; fingerprint: string }
  | { kind: "changed"; knownFingerprint: string; offeredFingerprint: string; firstSeen: string }

function file(): string {
  return path.join(app.getPath("userData"), "known-publishers.json")
}

async function read(): Promise<Record<string, KnownPublisher>> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Record<string, KnownPublisher>
  } catch {
    // A missing or unreadable file means nothing is known yet, which is the
    // honest answer and the safe one: every publisher looks new, and a new
    // publisher is something the person is asked about.
    return {}
  }
}

// judge says what this machine makes of a pack's signature, without deciding
// anything. The decision belongs to whoever is installing.
export async function judge(publisherName: string, publicKey: string | undefined, signed: boolean): Promise<PublisherVerdict> {
  if (!signed || !publicKey) return { kind: "unsigned" }
  const known = (await read())[publisherName]
  if (!known) return { kind: "first-sight", fingerprint: fingerprint(publicKey) }
  if (known.publicKey === publicKey) return { kind: "known", fingerprint: fingerprint(publicKey) }
  return {
    kind: "changed",
    knownFingerprint: fingerprint(known.publicKey),
    offeredFingerprint: fingerprint(publicKey),
    firstSeen: known.firstSeen,
  }
}

// remember writes a key down the first time. It never overwrites: a key that
// changed is exactly the case this file exists to notice, and quietly accepting
// the new one would throw that away.
export async function remember(publisherName: string, publicKey: string): Promise<void> {
  const all = await read()
  if (all[publisherName]) return
  all[publisherName] = { name: publisherName, publicKey, firstSeen: new Date().toISOString() }
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(all, null, 2), "utf8")
}

export async function knownPublishers(): Promise<KnownPublisher[]> {
  return Object.values(await read()).sort((a, b) => a.name.localeCompare(b.name))
}

// forget drops what is known about one publisher, which is how somebody accepts
// a rotation they have checked by other means. It is deliberately a separate,
// named act rather than a flag on install.
export async function forgetPublisher(publisherName: string): Promise<void> {
  const all = await read()
  if (!all[publisherName]) return
  delete all[publisherName]
  await fs.writeFile(file(), JSON.stringify(all, null, 2), "utf8")
}
