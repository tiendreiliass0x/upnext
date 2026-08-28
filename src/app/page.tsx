import Dashboard from "@/components/Dashboard";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[]; playlist?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = Array.isArray(params.session)
    ? params.session[0]
    : params.session;
  const playlist = Array.isArray(params.playlist)
    ? params.playlist[0]
    : params.playlist;

  return <Dashboard initialSessionId={session} initialPlaylistId={playlist} />;
}
