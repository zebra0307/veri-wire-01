"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 10);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <header
      className={`fixed left-0 right-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-zinc-200 bg-white/95 backdrop-blur-md shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
          : "border-b border-transparent bg-transparent backdrop-blur-0"
      }`}
    >
      <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-6">
        <p className="text-xl font-bold tracking-tight text-zinc-900">
          veri-wire
        </p>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="rounded-full px-4 py-2 text-sm font-medium text-vv-muted transition-colors hover:text-vv-text"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="rounded-full bg-vv-accent px-5 py-2.5 text-sm font-semibold text-white shadow-xl shadow-[rgba(255,107,53,0.35)] transition-transform hover:scale-105 active:scale-95"
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
}
