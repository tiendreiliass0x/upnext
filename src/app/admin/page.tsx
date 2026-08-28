import AdminLibraries from "@/components/AdminLibraries";

export const metadata = {
  title: "UP/NEXT admin | Libraries",
  // The catalogue is not something to surface in search results.
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminLibraries />;
}
