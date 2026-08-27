export const anonymousVoterHeader = "x-upnext-voter-id";

export function normalizeAnonymousVoterId(value: unknown) {
  if (typeof value !== "string") return null;
  const voterId = value.trim();
  if (
    voterId.length < 16 ||
    voterId.length > 100 ||
    !/^[A-Za-z0-9_-]+$/.test(voterId)
  ) {
    return null;
  }
  return voterId;
}

export function getAnonymousVoterId(request: Request) {
  return normalizeAnonymousVoterId(request.headers.get(anonymousVoterHeader));
}
