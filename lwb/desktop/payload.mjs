/**
 * Copy the product source a Desktop build ships into a payload directory.
 *
 * Capability packs come from the resolved edition one at a time, so a directory
 * that is merely present under `lwb/packs/` can never reach a product build.
 * Dependencies, pack test trees and repository metadata are excluded everywhere.
 * A pack checkout's build bookkeeping (`.build`), preview output (`.preview`)
 * and CI workflows (`.github`) are excluded too: the release runner archives
 * tracked pack sources without them, so a local build that shipped them would
 * produce a different payload, and a different build id, for the same revision.
 * `onFile` receives a location-independent key for every file that ships, which
 * keeps a build id reproducible when a private pack is checked out elsewhere.
 */
import { cp, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

/** Product directories that always ship, with the pack set beside them. */
export const PRODUCT_PATHS = ['dsh-bundle', 'pack-sdk', 'profile-setup.mjs']
const EXCLUDED = new Set(['node_modules', 'test', '.git', '.build', '.preview', '.github'])
/* Credential-like basenames: a checkout may carry .env files, key material or
   an .npmrc with a registry token that gitignore keeps out of a release
   archive but a local `cp` would happily ship. Skipping (not failing) keeps
   local-build and snapshot payloads identical; every skip is reported so the
   leak-shaped file is still reviewed by a human. */
const CREDENTIAL_FILE = [
  /^\.env(?:\..+)?$/u,
  /\.(?:pem|key|p12|pfx)$/u,
  /credential/iu,
  /secret/iu,
  /^\.npmrc$/u,
]

/**
 * @param {object} options
 * @param {string} options.projectRoot Repository root that owns `lwb/`.
 * @param {{ packs: ReadonlyArray<{ id: string, source: string }> }} options.edition Resolved edition.
 * @param {string} options.payload Destination directory for the product source.
 * @param {(key: string, source: string) => Promise<void> | void} [options.onFile] Called once per shipped file.
 * @returns {Promise<{ skipped: string[] }>} Payload-relative keys of every credential-like file excluded from the build.
 */
export async function assembleProductPayload({ projectRoot, edition, payload, onFile = () => {} }) {
  const skipped = []
  const excluded = (root, source) => relative(root, source).split(sep).some(part => EXCLUDED.has(part))
  const credentialLike = part => CREDENTIAL_FILE.some(pattern => pattern.test(part))
  const copy = async (root, destination, keyOf) => {
    await cp(root, destination, {
      recursive: true,
      filter: async (source) => {
        if (excluded(root, source)) return false
        if (credentialLike(basename(source))) { skipped.push(keyOf(source)); return false }
        if ((await stat(source)).isFile()) await onFile(keyOf(source), source)
        return true
      },
    })
  }
  const lwb = join(projectRoot, 'lwb')
  for (const path of PRODUCT_PATHS) {
    await copy(join(lwb, path), join(payload, 'lwb', path), source => relative(projectRoot, source))
  }
  for (const pack of edition.packs) {
    await copy(pack.source, join(payload, 'lwb', 'packs', pack.id), source => join('packs', pack.id, relative(pack.source, source)))
  }
  if (skipped.length) console.warn(`[payload] excluded ${skipped.length} credential-like file(s) from the build: ${skipped.join(', ')}`)
  return { skipped }
}