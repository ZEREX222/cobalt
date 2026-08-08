import { compareVersions } from 'compare-versions';

export function getVersionFromPath(path: string) {
	return path.split('/').pop()?.split('.md').shift()!;
}

export function getAllChangelogs() {
	const changelogImports = import.meta.glob('/changelogs/*.md');

	return Object.keys(changelogImports)
		.map((path) => ({
			path,
			version: getVersionFromPath(path),
			changelog: changelogImports[path]
		}))
		.sort((a, b) => compareVersions(b.version, a.version));
}