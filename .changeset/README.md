# Changesets

This repository uses [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs.

## Adding a changeset

When you make a change that should be released, run:

```bash
pnpm changeset
```

This will prompt you to:
1. Select which packages are affected
2. Choose the semver bump type (patch/minor/major)
3. Write a summary of the change

The changeset file will be committed with your PR.

## How releases work

When PRs with changesets are merged to `main`:
1. A "Version Packages" PR is automatically created/updated
2. This PR bumps versions and updates CHANGELOGs
3. When that PR is merged, packages are automatically published to npm

## Packages managed by changesets

- `dynamic-workflows` - Dynamic Workflows integration library

## Ignored packages (not published)

- `dynamic-workflows-tests` - Internal tests
- `basic-example` - Example project
