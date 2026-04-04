import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        vw: {
          bg: "#09090b", // Deep charcoal/graphite
          surface1: "#111113",
          surface2: "#18181b",
          surface3: "#27272a",
          
          accent: "#22d3ee", // Electric cyan
          pending: "#f59e0b", // Amber
          closed: "#52525b", // Muted neutral
          
          supports: "#10b981", // Controlled green
          refutes: "#ef4444", // Sharp red
          context: "#6366f1", // Violet-gray/Steel blue
          
          text: "#f4f4f5",
          muted: "#71717a",
          border: "rgba(255,255,255,0.08)",
          agentGlow: "#22d3ee"
        },
        vv: {
          bg: "#09090b",
          surface1: "#111113",
          surface2: "#18181b",
          surface3: "#27272a",
          accent: "#22d3ee",
          amber: "#f59e0b",
          emerald: "#10b981",
          crimson: "#ef4444",
          slate: "#71717a",
          text: "#f4f4f5",
          muted: "#71717a",
          border: "rgba(255,255,255,0.08)",
          agentGlow: "#22d3ee"
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
