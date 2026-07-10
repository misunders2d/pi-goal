import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(manifest.name, "@misunders2d/pi-goal");
assert.equal(manifest.license, "MIT");
assert.ok(manifest.keywords.includes("pi-package"), "pi-package keyword is required for pi.dev discoverability");
assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
assert.match(manifest.pi.image, /^https:\/\/raw\.githubusercontent\.com\/misunders2d\/pi-goal\/main\/media\/.+\.png$/);
assert.ok(existsSync(resolve(root, "media/pi-goal-preview.png")), "gallery preview image must exist before release");
assert.equal(manifest.publishConfig.access, "public");
for (const dependency of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
	assert.equal(manifest.peerDependencies[dependency], "*", `${dependency} must be an unbundled Pi peer dependency`);
}
const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
const pack = JSON.parse(output)[0];
assert.ok(pack, "npm pack returned no manifest");
const files = pack.files.map((entry: { path: string }) => entry.path);
for (const forbidden of [/^node_modules\//, /^\.git\//, /(?:^|\/)state\.json$/, /events\.jsonl$/, /evidence\.json$/, /auth\.json$/, /\.env(?:\.|$)/]) {
	assert.equal(files.some((path: string) => forbidden.test(path)), false, `tarball contains forbidden path matching ${forbidden}`);
}
for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts", "media/pi-goal-preview.png"]) assert.ok(files.includes(required), `tarball missing ${required}`);
console.log(`package metadata valid; ${files.length} files; unpacked ${pack.unpackedSize} bytes`);
