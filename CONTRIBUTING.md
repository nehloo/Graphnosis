# Contributing to Graphnosis

Thanks for considering a contribution. Before opening a PR, please read this guide and the [ROADMAP](./ROADMAP.md) so the work fits the project's direction and your time is well spent.

## Scope

Graphnosis is a small, focused SDK for in-process AI-native dual-graph knowledge representation. We deliberately keep it **small, focused, and infrastructure-free** so it remains easy to embed in any environment.

See [ROADMAP.md](./ROADMAP.md) for what's in scope vs. out of scope. If your change falls outside scope, please open an issue first to discuss — or consider publishing it as a separate package that depends on Graphnosis (we'll happily link to community packages from the README).

## Before you open a PR

1. **Open an issue first** for anything larger than a typo, doc fix, or one-file bugfix. This avoids wasted work if the change conflicts with the roadmap.
2. **One change per PR.** Small, focused PRs review faster and merge sooner.
3. **Match the existing style.** TypeScript strict mode, no `any` without explicit justification, prefer named exports, prefer pure functions where reasonable.
4. **Add or update tests** when fixing bugs or adding features. The benchmark suite (`tests/longmemeval`) should not regress.
5. **Update the docs** if your change affects public API surface.

## CLA — Contributor License Agreement

Before your first PR can be merged, you'll be asked to sign the project's [Contributor License Agreement](./CLA.md). This happens automatically — a bot will comment on your PR with a one-click sign link.

**Why a CLA?** Graphnosis is licensed Apache-2.0 and will remain so. The CLA preserves the project's flexibility to evolve while ensuring all contributions can be redistributed under the project's license. It's standard practice for actively maintained open-source projects.

It takes about 30 seconds.

## Workflow

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/Graphnosis.git
cd Graphnosis

# 2. Install dependencies
npm install

# 3. Run tests and the build
npm run lint:lib
npm run build:lib

# 4. Make your changes on a branch
git checkout -b fix/your-thing

# 5. Commit with a clear message — conventional commit style is appreciated
#    feat: ..., fix: ..., docs: ..., refactor: ..., test: ..., chore: ...

# 6. Push and open a PR against `main`
```

## Communication

- **Bug reports** → GitHub Issues with reproducer
- **Feature proposals** → GitHub Issues, label `proposal`, link to the relevant ROADMAP section
- **Security issues** → please **do not** open a public issue; email `security@graphnosis.com`

## What we will NOT accept

- Breaking changes to the `.aikg` binary format without prior issue discussion and a clear migration story
- Changes that require network egress from the core SDK (the SDK is offline-first; network-using features belong in adapter packages)
- Vendored binaries or large model files in this repository
- PRs that introduce a new runtime dependency without justification in the issue

## Recognition

Substantial contributions are credited in release notes. We're happy to add contributors to a `CONTRIBUTORS.md` file (and to the npm package metadata for sustained contributors).

Thanks for helping make Graphnosis better.
