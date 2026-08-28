# Miss-fire: aborting the R2 PUT on client disconnect

**When:** 2026-08-28, commit 407914f (reverted in the following commit).

**What I decided:** wire `request.signal` into the R2 `PutObject` so a DJ
navigating away mid-upload cancels the write and frees the job slot.

**Why I decided it:** a code review listed it as an optional item ("request.signal
is no longer threaded anywhere"). I treated the review as a checklist and
restored the behaviour the old ffmpeg path had, without asking whether it was
right for the new path.

**What the expert would have said:** by the time the handler runs, Next has
already parsed the whole multipart body — the 60 MB is on the server, paid for
over venue wifi. The signal fires on any disconnect, and the common disconnect is
a wifi blip with the booth page still open. Finishing and registering the PUT
makes that retry (same `x-upnext-upload-id`) instant; aborting forces another
60 MB. The rare case (a real navigation) costs one unreferenced object that
cleanup reaps after the grace period. The abort optimises the rare case at the
expense of the common one.

**Lesson:** a reviewer's "optional" item is a prompt to think, not an
instruction. The question is always what the domain expert would do with this
design, not whether an old behaviour can be restored.
