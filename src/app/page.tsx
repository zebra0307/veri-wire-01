import Link from "next/link";
import { ArrowRight, Database, FileEdit, Users } from "lucide-react";
import { LandingHeader } from "@/components/landing/landing-header";
import { ThreadAnimation } from "@/components/landing/thread-animation";
import { env } from "@/lib/env";

const workflow = [
  {
    step: "01",
    title: "Create Rumour",
    desc: "Capture any unverified claim, image, or video and route it into a structured investigation room.",
    icon: FileEdit,
    tone: "border-vv-accent/70 bg-vv-accent/15 text-vv-accent"
  },
  {
    step: "02",
    title: "Query Evidence",
    desc: "Cross-reference claims against submitted sources and ongoing room discussions in one shared thread.",
    icon: Database,
    tone: "border-vv-amber/70 bg-vv-amber/15 text-vv-amber"
  },
  {
    step: "03",
    title: "Resolve Together",
    desc: "Collaborators and agents converge on clear, source-backed outcomes with transparent reasoning.",
    icon: Users,
    tone: "border-vv-crimson/60 bg-vv-crimson/15 text-vv-crimson"
  }
] as const;

export default function Home() {
  const startHref = env.DEMO_BYPASS_AUTH ? "/app" : "/login";

  return (
    <div className="min-h-screen overflow-x-hidden bg-white text-vv-text selection:bg-vv-accent/30 selection:text-vv-text">
      <LandingHeader />

      <main className="relative z-10 pt-24">
        <section className="relative overflow-hidden pb-36 pt-36 text-center">
          <ThreadAnimation />

          <div className="relative mx-auto w-full max-w-7xl px-6">
            <h1
              className="mx-auto mb-8 max-w-5xl text-5xl font-extrabold leading-[1.05] tracking-tight text-zinc-900 md:text-7xl"
              style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
            >
              <span className="text-vv-accent">feeling rumourous ?</span>
              <br className="hidden md:block" />
              come join the tribe
            </h1>

            <p className="mx-auto mb-10 max-w-2xl text-lg font-light leading-relaxed text-vv-muted md:text-xl">
              Collaborative misinformation resolution. Solve unsolved rumours with shared evidence and agent support.
            </p>

            <Link
              href={startHref}
              className="group inline-flex items-center gap-2 rounded-full border border-orange-300 bg-gradient-to-r from-white to-orange-300 px-8 py-4 font-bold text-zinc-900 shadow-xl shadow-[rgba(255,107,53,0.2)] transition-transform hover:scale-105 active:scale-95"
            >
              Create Rumour
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-6 py-28">
          <div className="mb-20 text-center">
            <h2 className="mb-4 text-4xl font-bold tracking-tight text-zinc-900">The Ethereal Workflow</h2>
            <p className="mx-auto max-w-xl text-vv-muted">
              From messy misinformation to clear verification in three deliberate steps.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            {workflow.map((step) => {
              const Icon = step.icon;

              return (
                <article
                  key={step.step}
                  className="group rounded-[2rem] border border-orange-200 bg-gradient-to-br from-white via-orange-50 to-orange-100 p-8 shadow-lg shadow-[rgba(255,107,53,0.14)] transition-all hover:-translate-y-1.5 hover:border-orange-300 hover:shadow-xl"
                >
                  <div className={`mb-8 flex h-14 w-14 items-center justify-center rounded-2xl border ${step.tone}`}>
                    <Icon className="h-7 w-7" />
                  </div>

                  <p className="mb-2 text-xs font-black tracking-[0.22em] text-vv-muted">{step.step}</p>
                  <h3 className="mb-3 text-2xl font-bold text-zinc-900">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-vv-muted">{step.desc}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-6 py-24">
          <div className="rounded-[2.5rem] border border-orange-200 bg-gradient-to-br from-white via-orange-50 to-orange-100 px-10 py-16 text-center shadow-xl shadow-[rgba(255,107,53,0.16)] md:px-20 md:py-24">
            <h2 className="mb-8 text-4xl font-bold tracking-tight text-zinc-900 md:text-6xl">Ready to verify the world?</h2>
            <p className="mx-auto mb-12 max-w-xl text-lg text-vv-muted">
                Join researchers and contributors in the fight for objective reality.
            </p>

            <Link
              href={startHref}
              className="inline-flex rounded-full border border-orange-300 bg-gradient-to-r from-white to-orange-300 px-10 py-5 text-lg font-bold text-zinc-900 shadow-xl shadow-[rgba(255,107,53,0.2)] transition-transform hover:scale-105 active:scale-95"
            >
              Create Rumour Now
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-orange-200 px-6 pb-16 pt-24">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mb-14 grid gap-12 md:grid-cols-4">
            <div className="md:col-span-2">
              <p className="mb-5 text-lg font-bold text-zinc-900">veri-wire</p>
              <p className="max-w-xs leading-relaxed text-vv-muted">
                The global standard for misinformation resolution, powered by contributors and transparent evidence.
              </p>
            </div>

            <div>
              <h4 className="mb-6 text-xs font-bold uppercase tracking-[0.2em] text-vv-muted">Platform</h4>
              <ul className="space-y-3 text-sm font-medium text-vv-muted">
                <li>Rumour Rooms</li>
                <li>Agent Insights</li>
                <li>Truth Index</li>
              </ul>
            </div>

            <div>
              <h4 className="mb-6 text-xs font-bold uppercase tracking-[0.2em] text-vv-muted">Get Started</h4>
              <ul className="space-y-3 text-sm font-medium text-vv-muted">
                <li>
                  <Link href={startHref} className="transition-colors hover:text-vv-accent">
                    Log in
                  </Link>
                </li>
                <li>
                  <Link href={startHref} className="transition-colors hover:text-vv-accent">
                    Join the tribe
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col items-center justify-between gap-6 border-t border-orange-200 pt-8 text-center md:flex-row md:text-left">
            <p className="text-sm font-medium italic text-vv-text" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
              feeling rumourous ? come join the tribe
            </p>
            <p className="text-sm text-vv-muted">© 2026 veri-wire platform.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

