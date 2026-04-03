import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        vv: {
          bg: "#0f0e0d",
          surface1: "#161513",
          surface2: "#1c1a18",
          surface3: "#232120",
          accent: "#2dd4bf",
          amber: "#f59e0b",
          emerald: "#10b981",
          crimson: "#ef4444",
          slate: "#6b7280",
          text: "#e5e4e2",
          muted: "#6b6a68",
          border: "rgba(255,255,255,0.07)",
          agentGlow: "#6366f1"
        }
      },
      fontFamily: {
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--font-inter)", "sans-serif"]
      },
      boxShadow: {
        agent: "0 0 0 1px rgba(99,102,241,0.45), 0 0 24px rgba(99,102,241,0.12)",
        card: "0 8px 24px rgba(0,0,0,0.35)"
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        pulseBar: {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.85" }
        }
      },
      animation: {
        rise: "rise 420ms cubic-bezier(0.22, 1, 0.36, 1)",
        pulseBar: "pulseBar 1.8s ease-in-out infinite"
      }
    }
  },
  plugins: []
};

export default config;
