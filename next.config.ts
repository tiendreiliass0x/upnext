import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";
import path from "node:path";

// Fail with a sentence rather than a segfault. better-sqlite3 13 is built
// against N-API 10, which Node grew in 24; an older Node loads the binding
// and dies with SIGSEGV and no message, on the first database call after
// the server is already up. That happens in practice when a terminal opened
// before `nvm alias default 24` still has an old Node on its PATH. This file
// runs under the real runtime for dev, build and start alike, before any
// route loads the binding, so it is the one place to say so.
const requiredNodeMajor = 24;
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < requiredNodeMajor) {
  throw new Error(
    `UP/NEXT needs Node ${requiredNodeMajor}+ and this is ${process.version}. ` +
      "Run `nvm use` in this terminal (it reads .nvmrc), then start again.",
  );
}

// The addresses this machine has on its local networks, so a phone on the
// venue wifi can open the dev server by LAN IP and still get hot reload:
// Next blocks cross-origin requests to its dev resources unless the origin
// is listed. Computed here rather than typed in, because the IP changes
// with every network the laptop joins. Dev only; production is behind Caddy.
function localNetworkAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (address): address is NonNullable<typeof address> =>
        Boolean(address) && address!.family === "IPv4" && !address!.internal,
    )
    .map((address) => address.address);
}

// The named Cloudflare tunnels that front a dev server for anyone off the
// venue wifi, one per machine that runs the booth (see README, "Reaching the
// dev server from another network"). Listed with the LAN addresses so hot
// reload works through them too: Next refuses its dev websocket to any origin
// it was not told about.
const devTunnelHosts = ["dev.younext.dev", "sound.younext.dev"];

const nextConfig: NextConfig = {
  // The floating dev-tools badge sits on top of the booth UI.
  devIndicators: false,
  // Next 16 writes AGENTS.md and CLAUDE.md into the tree on every dev start.
  // Generated files that reappear are noise in the repo; off.
  agentRules: false,
  allowedDevOrigins:
    process.env.NODE_ENV === "production"
      ? undefined
      : [...localNetworkAddresses(), ...devTunnelHosts],
  // This repo lives under a directory that carries a pnpm-workspace.yaml for
  // other projects. Pin the root so Turbopack neither adopts that workspace
  // nor warns about ignoring it.
  turbopack: { root: path.resolve(__dirname) },
  // Traced, self-contained server output: the full node_modules tree is ~885MB,
  // most of it Next's own multi-platform SWC binaries, which is a lot to carry
  // onto a small VPS.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
