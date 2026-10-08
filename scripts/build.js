// dsh-translator build script (plain Node — runs as `prepublishOnly` before an
// npm publish, and by hand as `npm run build`).
//
// Writes every artifact `build-artifacts.js` renders:
//   lib/index.js          — packaged Host half (copy of src/index.js)
//   lib/free-translate.js — the keyless public provider chain it imports
//   lib/client.js         — client-modules bundle (core wrapped into
//                           window.__ModuleLoader__.load({ id, factory }))
//
// These files are COMMITTED. A git-hosted install packs the repository and
// never runs a build script, so the package has to already contain its output.
// `npm run verify:build` is what keeps them honest; run it before committing.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArtifacts } from './build-artifacts.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = await buildArtifacts(root)

await mkdir(join(root, 'lib'), { recursive: true })
for (const [relative, content] of artifacts) {
	await writeFile(join(root, relative), content)
}
console.log('built ' + [...artifacts.keys()].join(' + '))
