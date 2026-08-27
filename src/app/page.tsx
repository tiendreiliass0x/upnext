import Dashboard from "@/components/Dashboard";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = Array.isArray(params.session)
    ? params.session[0]
    : params.session;

  return <Dashboard initialSessionId={session} />;
}
