"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Where the OAuth redirect lands.
 *
 * The booth opens the provider in a popup rather than navigating, because the
 * setup screen holds the songs the DJ has already dragged in and a File
 * cannot survive a round trip through another origin. So the usual outcome of
 * this page is that it closes itself and the booth, which has been polling,
 * notices the connection appear.
 *
 * It still renders properly when it is a full tab: popups get blocked, and a
 * blank page saying nothing would be the worst possible end to a sign-in.
 */
const messages: Record<string, string> = {
  // What the popup shows for the instant before it is sent to the provider.
  pending: "Opening the sign-in...",
  ok: "Connected. You can close this window.",
  denied: "The sign-in was cancelled. Nothing was connected.",
  expired: "That sign-in took too long. Try connecting again.",
  invalid: "That sign-in link was incomplete. Try connecting again.",
  unknown: "That service is not available here.",
  failed: "The connection could not be completed. Try again.",
};

export default function ConnectDone() {
  const [isPopup, setIsPopup] = useState(false);
  const [status, setStatus] = useState("failed");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setStatus(params.get("status") ?? "failed");

    // window.opener is only set when the booth opened us. Closing a tab the
    // DJ opened themselves would be rude, and browsers refuse it anyway.
    const opened = Boolean(window.opener) && window.opener !== window;
    setIsPopup(opened);
    if (!opened || params.get("status") === "pending") return;

    // A beat so the outcome is readable if the close is refused.
    const timer = window.setTimeout(() => window.close(), 600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="upnext-app">
      <header className="app-header">
        <span className="wordmark">
          <span className="wordmark-dot" aria-hidden="true" />
          YOU/NEXT
        </span>
      </header>
      <main className="page-shell">
        <p className="library-empty" role="status">
          {messages[status] ?? messages.failed}
          {!isPopup && (
            <>
              {" "}
              <Link href="/">Back to the booth</Link>
            </>
          )}
        </p>
      </main>
    </div>
  );
}
