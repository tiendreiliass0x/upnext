# Miss-fire: sizing the Node 24 upgrade before running anything on it

**When:** 2026-08-29, answering "why node 22 / can you upgrade bun".

**What I decided:** told the user the Node 24 move was "a small PR — the three
pins plus a `.nvmrc`", and that `better-sqlite3` 11.10 "ships prebuilds for it".

**Why I decided it:** the prebuild list and the LTS calendar were both true,
and I let two true facts stand in for a test run.

**What the expert would have said:** a runtime major is sized by running the
suite on it, not by reading release notes. On the first run, two test files
aborted the Node process (`RemoveEnvironmentCleanupHook: (env) != nullptr`
from `Statement::~Statement()` during GC) — a Node 24 / better-sqlite3 11.x
interaction that upstream had already closed as "11.10.0 is outdated". The
upgrade was really Node 24 **plus** a major bump of the SQLite binding to the
N-API line, with the Dockerfile's reasoning rewritten. That is a different
size and a different review.

**Lesson:** "supported" means a binary loads; it does not mean a suite passes.
Say "I'll size it once the suite has run on it", then run it.
