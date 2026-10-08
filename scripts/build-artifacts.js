// The build's single source of truth.
//
// `build.js` writes exactly what this returns and `verify-build.js` compares
// the committed copies against it, so the writer and the checker can never
// disagree about what the artifacts are supposed to contain.
//
// Why the artifacts are committed at all: a git-hosted dependency is packed
// from the repository and installed without running lifecycle scripts unless
// the user pre-authorizes them. pnpm refuses `prepare` on a git dependency
// unless `allowBuilds` lists it under a key that embeds the resolved URL and
// commit hash — a key that changes with every commit. Shipping the built files
// removes the question entirely, which is what "no configuration" has to mean
// for an install too.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Render every build artifact.
 *
 * @param root - package root directory.
 * @returns path relative to the package root → exact file content.
 */
export async function buildArtifacts(root) {
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

	// The Host half is more than one file: src/index.js imports the provider
	// chain, so every module under src/ ships beside it under the same name.
	const hostModules = ['index.js', 'free-translate.js']
	const artifacts = new Map()
	for (const module of hostModules) {
		artifacts.set('lib/' + module, await readFile(join(root, 'src', module), 'utf8'))
	}

	// The Client half is a browser script body, not a module: the loader hands
	// it a `require` and expects `window.__ModuleLoader__.load`, so it has to be
	// wrapped rather than copied.
	const core = await readFile(join(root, 'client/core.js'), 'utf8')
	artifacts.set('lib/client.js', `window.__ModuleLoader__.load({
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
`)

	return artifacts
}
