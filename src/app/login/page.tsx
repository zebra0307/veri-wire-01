import Link from "next/link";
import { env } from "@/lib/env";

export default function LoginPage() {
  const hasGithub = Boolean(env.GITHUB_ID && env.GITHUB_SECRET);
  const hasEmail = Boolean(
    env.EMAIL_SERVER_HOST &&
      env.EMAIL_SERVER_PORT &&
      env.EMAIL_SERVER_USER &&
      env.EMAIL_SERVER_PASSWORD &&
      env.EMAIL_FROM
  );
  const demoAvailable = env.DEMO_BYPASS_AUTH;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6 text-vv-text">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-vv-accent">VeriWire</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-vv-muted">
          Rooms and API routes require a session unless demo bypass is enabled for local development.
        </p>
      </div>

      <div className="flex flex-col gap-3 border border-white/10 bg-vv-surface1/90 p-4">
        {hasGithub ? (
          <a
            href="/api/auth/signin/github"
            className="border border-white/20 bg-white/[0.06] px-4 py-3 text-center text-sm font-semibold hover:bg-white/[0.1]"
          >
            Continue with GitHub
          </a>
        ) : null}

        {hasEmail ? (
          <a
            href="/api/auth/signin/email"
            className="border border-white/20 bg-white/[0.06] px-4 py-3 text-center text-sm font-semibold hover:bg-white/[0.1]"
          >
            Sign in with email (magic link)
          </a>
        ) : null}

        {!hasGithub && !hasEmail ? (
          <p className="text-sm text-vv-amber">
            No sign-in providers are configured. Add <span className="font-mono">GITHUB_ID</span> /{" "}
            <span className="font-mono">GITHUB_SECRET</span> and/or SMTP settings in your environment, then restart
            the app.
          </p>
        ) : null}

        {demoAvailable ? (
          <p className="border-t border-white/10 pt-3 text-xs text-vv-muted">
            Demo bypass is on: the app will use a synthetic moderator user without OAuth. Turn off{" "}
            <span className="font-mono">DEMO_BYPASS_AUTH</span> for real authentication.
          </p>
        ) : null}
      </div>

      <Link href="/" className="text-center text-sm text-vv-muted underline hover:text-vv-text">
        Back to app
      </Link>
    </main>
  );
}
