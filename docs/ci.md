# CI & Monorepo Publishing

Leitwerk uses GitHub Actions to run CI checks on pull requests and publish `@leitwerk-dev/*` packages to npm on release tags.

---

## 1. Workflows

- **CI (`ci.yml`):** Triggers on pull requests and pushes to `main`. Runs linting, `npm run test:full`, `npm run docs:build`, and `npm run publish:dry-run`.
- **Publish (`publish.yml`):** Triggers on GitHub Releases matching `v<version>`. Re-runs the full CI gate and publishes all workspace packages under the `@leitwerk-dev` scope.

---

## 2. Creating a Release

To release a new version across the monorepo:

1. **Bump Version:** Update version numbers in `package.json` files and internal `@leitwerk-dev/*` dependencies.
2. **Run Local Validation:**
   ```bash
   npm run test:full
   npm run docs:build
   npm run publish:dry-run
   ```
3. **Commit & Tag:**
   ```bash
   git commit -am "release: v1.2.0"
   git tag v1.2.0
   git push origin main --tags
   ```
4. **Publish Release:** Create a GitHub Release for `v1.2.0` to trigger the automated `publish.yml` workflow.
