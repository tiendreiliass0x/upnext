# Miss-fire: `localhost` in the tunnel ingress, and probing a path from memory

**When:** 2026-08-29, while setting up the named Cloudflare tunnel
`dev.younext.dev` → `next dev` (PR "Name the dev tunnel").

**What I decided (1):** wrote the ingress as `service: http://localhost:3000`.

**Why I decided it:** it is the conventional spelling and the one the
Cloudflare docs use in their example.

**What the expert would have said:** a Go dialer resolves `localhost` to
`::1` first. Next's dev server listens on the dual-stack wildcard so the
HTTP path happens to fall back to IPv4, but cloudflared's websocket path does
not fall back, so hot reload 502s while pages load. The dev server's own
address is `127.0.0.1`; an origin address in a config file should name the
address the service actually binds, not a name whose resolution depends on
the client. Cost: one 502 debugging cycle before the log line
`dial tcp [::1]:3000: connect: connection refused` made it obvious.

**What I decided (2):** probed the HMR websocket at `/_next/webpack-hmr` with
hand-rolled handshakes and drew conclusions from the responses.

**Why I decided it:** that was the path in the Next versions I remembered.

**What the expert would have said:** observe the real client first. One
headless-Chrome load of the LAN page showed Next 16.3's Turbopack client
connects to `/_next/hmr?id=…`; the old path is not handled as an upgrade at
all, which is why the probes hung rather than answered. Every conclusion
drawn from the probes before that was about the wrong endpoint.

**Lesson:** when verifying a protocol detail, capture what the actual client
does before constructing requests from memory; and put concrete addresses,
not resolvable names, in origin configs.
