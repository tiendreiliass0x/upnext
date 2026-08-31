import { soundcloud } from "@/lib/providers/soundcloud";
import type { MusicProvider, ProviderId } from "@/lib/providers/types";

const providers: Record<ProviderId, MusicProvider> = { soundcloud };

export function getProvider(id: string): MusicProvider | null {
  return Object.prototype.hasOwnProperty.call(providers, id)
    ? providers[id as ProviderId]
    : null;
}

/** Only the ones this deployment actually holds client credentials for. */
export function configuredProviders() {
  return Object.values(providers).filter((provider) => provider.isConfigured());
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && getProvider(value) !== null;
}

export * from "@/lib/providers/types";
