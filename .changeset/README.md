# Changesets

Every pull request that changes what users get (a `feat`, `fix`, `perf` or `revert`) needs a changeset: a short note that becomes the CHANGELOG entry and decides the version bump.

```sh
npx changeset
```

Pick `patch` for fixes, `minor` for features (and, before 1.0.0, for breaking changes), then write one or two sentences for users. Commit the generated `.changeset/*.md` file with your change.

See [docs/RELEASING.md](../docs/RELEASING.md) for how releases are made.
