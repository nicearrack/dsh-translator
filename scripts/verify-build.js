// Fail when the committed build output no longer matches its sources.
//
// lib/ is version-controlled so that installing from git or a GitHub tarball
// works without running a build script. That trade is only safe if a stale
// artifact cannot be committed by accident, which is what this checks —
// `npm run check` calls it, and so should CI.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArtifacts } from './build-artifacts.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = await buildArtifacts(root)

const stale = []
for (const [relative, expected] of artifacts) {
	let actual = null
	try {
		actual = await readFile(join(root, relative), 'utf8')
	} catch {
		actual = null
	}
	if (actual !== expected) stale.push(relative)
}

if (stale.length > 0) {
	console.error('lib/ is out of date with src/ and client/: ' + stale.join(', '))
	console.error('These files are committed so a git install needs no build script.')
	console.error('Run `npm run build` and commit the result.')
	process.exit(1)
}
console.log('lib/ matches src/ and client/')
