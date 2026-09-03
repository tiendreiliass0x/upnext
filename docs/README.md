# Design docs

One file per decision that was expensive to make and would be expensive to
re-make. The point is that the next person — including the one who wrote it —
can tell what was considered and rejected, not just what shipped.

## What goes where

| | |
|---|---|
| `docs/` | **Why** a design is the way it is. Alternatives weighed, constraints that forced a hand, trade-offs accepted. Written once, revised when the decision changes. |
| `README.md` | **How** to run and configure the thing. Operator-facing. Should stay short enough to read straight through. |
| `internal-thoughts/` | **What went wrong.** Dated, first-person post-mortems on a specific misfire, ending in a lesson. Never revised — they are a record. |
| Code comments | Why *this line* is surprising. The house style already leans on these heavily; a design doc is for what no single comment can hold. |

A doc here earns its place by answering a question that would otherwise be
re-litigated. "We use SQLite" does not need one. "We do not support Spotify,
and here is the evidence" does.

## Convention

- `NNNN-short-name.md`, numbered in the order written, so a doc can be cited by
  number and the number never moves.
- Start from [`TEMPLATE.md`](TEMPLATE.md).
- Record the date and the commit the decision landed in. A design doc is a
  snapshot of what was true and known then; when reality moves, add a
  **Superseded by** line at the top rather than quietly editing history.
- Link the evidence. An external constraint — an API's terms, a quota, a
  deprecation notice — is the whole argument in a lot of these, and a claim
  without a URL rots into folklore.

## Index

| # | Doc | Status |
|---|-----|--------|
| 0001 | [Connected music accounts](0001-connected-music-accounts.md) | Accepted |
| 0002 | [Profile pictures and the name beside a vote](0002-profile-pictures.md) | Accepted |

## Worth writing next

The subsystems where the reasoning currently lives only in code comments and
commit messages, roughly in order of how often it gets asked about:

- **Vote counting, cooldown, and pick order.** Why a play spends its votes, why
  the cooldown clamps to what the room can roll, and why the ballot and the
  crowd pick share one SQL ordering.
- **Audio storage.** Why full songs and not clips, why `preview_key` still has
  that name, and what the signed-URL window does and does not bound.
- **Voting identity.** Why phone login is unverified on purpose, why that sets
  the bar where it is, and why `/admin` hangs off a separate secret instead.
- **Now-playing sync.** Why the room polls rather than holding a socket, and
  how a listening phone decides whether to re-seek or carry on.
