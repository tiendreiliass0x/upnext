# Working on UP/NEXT

## Branches

- `main` is production. Every push to it runs [CI](.github/workflows/ci.yml)
  and, when it passes, [deploys](.github/workflows/deploy.yml). Do not push to
  it directly — it is protected.
- Work happens on short-lived branches off `main`: `feat/…`, `fix/…`,
  `chore/…`. Rebase on `main` rather than merging it in.
- Open a pull request. CI has to be green; then **squash-merge**, so `main`
  reads as one commit per change and can be bisected.

## Commits

Imperative subject line under 72 characters that says what changes, not what
you did: "Cap uploads at 60 MB", not "updated route". Put the reasoning and
the trade-offs in the body — the PR template asks for the same thing.

## Design docs

A change that closes off an option — picking one provider over another, ruling
a whole approach out, accepting a constraint you cannot lift — gets a file in
[`docs/`](docs/). Start from [`docs/TEMPLATE.md`](docs/TEMPLATE.md) and add it
to the index.

The test is whether someone would otherwise re-litigate it in three months.
Most changes do not need one; the ones that do are obvious in hindsight and
expensive to reconstruct. Keep the *why* there and the *how to run it* in the
README.

## Before you push

```sh
bun install
bunx tsc --noEmit
bun run lint
bun run test:coverage   # coverage thresholds are enforced
bun run build           # not while `bun run dev` is running — shared .next
```

## Releases

There are no version numbers. A deploy is a commit on `main`; the image is
tagged `sha-<12 chars>` and `latest`, and the VPS records which tag it runs in
its `.env` (`UPNEXT_IMAGE_TAG`). To roll back, re-run the Deploy workflow on
an older commit, or on the VPS set `UPNEXT_IMAGE_TAG` and
`docker compose up -d --no-build`.
