# Miss-fire: committed after an edit that had already failed

**Timestamp:** 2026-08-27 11:58:18 PDT
**Area:** dead-man switch commit (`cf4e322`, amended to `48f245f`)

## What happened

The heredoc applying the `.env.example` and README changes raised an
AssertionError on a stale anchor string. The very next lines in the same tool
call ran the test suite and `git add -A && git commit`. The commit landed with
only `scripts/run-cleanup.sh` in it, while its message described documentation
that was not in the tree.

## Why an expert rejects the choice

I sequenced a mutating, hard-to-reverse step (a commit) after an unchecked
step (a file edit), on separate lines, so a non-zero exit from the edit could
not stop the commit. `git status --short` printed clean afterwards, which
looks like confirmation and is not: it only says the index matches HEAD, not
that HEAD contains what the message claims.

The correct shapes are any of: `set -e` at the top of the block, joining the
steps with `&&`, or asserting the intended content is staged before
committing. I used none of them.

## Contributing cause

The anchor was stale because of an earlier edit of my own. When I set
`CLEANUP_ROOM_RETENTION_HOURS=24`, the script took the "key already present"
branch for `.env.example` and replaced the line in place, so the explanatory
comment was only ever appended to `.env`. I then wrote a later anchor from
memory of what I intended rather than from the file. Anchors should be read
back from the file, not recalled.

## Cost

Low, and only because the branch is unpushed: `git commit --amend` folded the
docs into the same commit. Had it been pushed, the fix would have been a
second commit correcting a first one whose message was inaccurate.

## Rule going forward

A commit is a checkpoint, not a step. Never let one execute in the same block
as an unverified mutation; gate it on the mutation succeeding, and verify the
staged diff contains what the message claims.
