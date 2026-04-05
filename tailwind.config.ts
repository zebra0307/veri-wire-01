import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        vw: {
          bg: "#2c2c2c",
          surface1: "#333333",
          surface2: "#3d3d3d",
          surface3: "#484848",

          accent: "#ff6b35",
          pending: "#ff8c42",
          closed: "#94a3b8",

          supports: "#4ade80",
          refutes: "#f87171",
          context: "#94a3b8",

          text: "#f5f5f5",
          muted: "#a8a8a8",
          border: "rgba(255,107,53,0.35)",
          agentGlow: "#ff7a4d"
        },
        vv: {
          bg: "#2c2c2c",
          surface1: "#333333",
          surface2: "#3d3d3d",
          surface3: "#484848",
          accent: "#ff6b35",
          amber: "#ff8c42",
          emerald: "#4ade80",
          crimson: "#f87171",
          slate: "#94a3b8",
          text: "#f5f5f5",
          muted: "#a8a8a8",
          border: "rgba(255,107,53,0.35)",
          agentGlow: "#ff7a4d"
        }
      },
      fontFamily: {
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--font-inter)", "sans-serif"]
      },
      boxShadow: {
        agent: "0 0 0 1px rgba(255,107,53,0.45), 0 0 24px rgba(255,107,53,0.2)",
        card: "0 10px 28px rgba(0,0,0,0.4)"
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
