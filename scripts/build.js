// dsh-translator build script (self-contained, plain Node — runs as `prepare`
// during git installs and before `npm publish`).
//
// Produces:
//   lib/index.js   — packaged Host half (copy of src/index.js)
//   lib/client.js  — client-modules bundle (core wrapped into
//                    window.__ModuleLoader__.load({ id, factory }))
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await mkdir(join(root, 'lib'), { recursive: true })

const index = await readFile(join(root, 'src/index.js'), 'utf8')
await writeFile(join(root, 'lib/index.js'), index)

const core = await readFile(join(root, 'client/core.js'), 'utf8')
const bundle = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${core}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`

await writeFile(join(root, 'lib/client.js'), bundle)
console.log(`built lib/index.js + lib/client.js (bundle id: ${pkg.name})`)
