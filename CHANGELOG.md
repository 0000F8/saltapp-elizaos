# Changelog

## 0.1.1

**The published package would have crashed on its first import.** `tsconfig`'s
`moduleResolution: "Bundler"` let every relative import omit its `.js` extension — fine for the
compiler, rejected by Node's real ESM loader, so `import "plugin-saltapp"` failed on the very first
internal import. Fixed across 14 files and verified by importing an actual packed tarball under
`node --input-type=module`. Also: `salt-agent-sdk` is required at `^0.12.2` (the old range could not
resolve the version this plugin is built against), a LICENSE file now accompanies the MIT claim in
`package.json`, and the release publishes from CI with a provenance attestation.

