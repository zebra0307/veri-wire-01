import Link from "next/link";
import { demoAccounts } from "@/lib/demo-auth";
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
    <main className="relative min-h-screen overflow-hidden bg-white text-vv-text selection:bg-vv-accent/30 selection:text-vv-text">
      <div className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 items-center gap-14 px-6 py-14 lg:grid-cols-2">
        <section className="space-y-6">
          <p className="inline-flex rounded-full border border-zinc-300 bg-gradient-to-r from-white to-orange-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-900">
            veri-wire
          </p>

          <h1
            className="text-5xl font-extrabold leading-[1.02] tracking-tight text-zinc-900 md:text-7xl"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            Happening now,
            <br />
            verify together.
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-zinc-700">
            Join collaborative rooms, challenge rumours with sources, and let agents help surface evidence-backed
            clarity.
          </p>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="rounded-[2rem] border border-orange-200 bg-gradient-to-br from-white via-orange-50 to-orange-100 p-7 shadow-xl shadow-[rgba(255,107,53,0.16)] md:p-8">
            <h2 className="text-3xl font-bold tracking-tight text-zinc-900">Sign in to VeriWire</h2>
            <p className="mt-2 text-sm text-zinc-700">
              Rooms and API routes require a session unless demo bypass is enabled for local development.
            </p>

            <div className="mt-7 space-y-3">
              {hasGithub ? (
                <a
                  href="/api/auth/signin/github"
                  className="flex w-full items-center justify-center rounded-full border border-orange-200 bg-gradient-to-r from-white to-orange-100 px-4 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:border-orange-300"
                >
                  Continue with GitHub
                </a>
              ) : null}

              {hasEmail ? (
                <a
                  href="/api/auth/signin/email"
                  className="flex w-full items-center justify-center rounded-full border border-orange-300 bg-gradient-to-r from-white to-orange-300 px-4 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:brightness-105"
                >
                  Sign in with email (magic link)
                </a>
              ) : null}

              {!hasGithub && !hasEmail ? (
                <p className="rounded-2xl border border-vv-amber/45 bg-vv-amber/10 px-4 py-3 text-sm text-vv-amber">
                  No sign-in providers are configured. Add <span className="font-mono">GITHUB_ID</span> /{" "}
                  <span className="font-mono">GITHUB_SECRET</span> and/or SMTP settings in your environment, then
                  restart the app.
                </p>
              ) : null}

              {demoAvailable ? (
                <>
                  <div className="rounded-2xl border border-orange-200 bg-gradient-to-br from-white via-orange-50 to-orange-100 px-4 py-3 text-xs leading-relaxed text-zinc-700">
                    <p className="font-semibold text-zinc-900">Demo accounts</p>
                    <p className="mt-1">
                      Pick any dummy account below. All demo accounts have full access so you can test realtime vote
                      updates across multiple sessions quickly.
                    </p>
                    <p className="mt-1">
                      Disable <span className="font-mono">DEMO_BYPASS_AUTH</span> to return to provider-only login.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {demoAccounts.map((account) => (
                      <a
                        key={account.id}
                        href={`/api/auth/demo-login?account=${account.id}&next=/app`}
                        className="block rounded-2xl border border-orange-200 bg-gradient-to-r from-white to-orange-100 px-4 py-3 transition-colors hover:border-orange-300"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-zinc-900">{account.name}</p>
                            <p className="text-xs text-zinc-700">{account.email}</p>
                          </div>
                          <span className="rounded-full border border-orange-300 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-900">
                            {account.role}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-zinc-700">{account.summary}</p>
                      </a>
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            <div className="mt-6 border-t border-orange-200 pt-4">
              <Link href="/" className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-vv-accent">
                Back to landing page
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
