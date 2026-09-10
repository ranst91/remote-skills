import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home-shell">
      <p className="eyebrow">REMOTE AUTHORITY · VERIFIED BYTES · LOCAL CONTEXT</p>
      <h1>
        Serve skills.
        <br />
        Don’t install them.
      </h1>
      <p className="home-deck">
        A field guide to publishing Agent Skills as a static origin and activating immutable,
        digest-verified snapshots from TypeScript or Python.
      </p>
      <div className="home-actions">
        <Link className="primary-action" href="/docs">
          Open the field guide
        </Link>
        <Link className="secondary-action" href="/docs/hosting/archive-to-origin">
          Host built output
        </Link>
      </div>
      <ol className="signal-line" aria-label="Remote Skills lifecycle">
        <li>01 DISCOVER</li>
        <li>02 ACTIVATE</li>
        <li>03 VERIFY</li>
        <li>04 PIN</li>
        <li>05 READ</li>
      </ol>
    </main>
  );
}
