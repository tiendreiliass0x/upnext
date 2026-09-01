import type { Metadata } from "next";
import ConnectDone from "@/components/ConnectDone";

export const metadata: Metadata = {
  title: "Connecting an account | YOU/NEXT",
  robots: { index: false, follow: false },
};

export default function ConnectDonePage() {
  return <ConnectDone />;
}
