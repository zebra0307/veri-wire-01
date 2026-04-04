import React from "react";
import {
  FileCheck2,
  List,
  Plus,
  ArrowRight,
  ShieldAlert,
  Search,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Clock
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ----------------------------------------------------------------------
// 1. App Shell Layout (Three-Panel Design)
// ----------------------------------------------------------------------
export function AppShell({
  sidebar,
  centerContent,
  rightPanel
}: {
  sidebar: React.ReactNode;
  centerContent: React.ReactNode;
  rightPanel: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full bg-vw-bg text-vw-text font-sans antialiased overflow-hidden">
      {/* Left Sidebar */}
      <aside className="w-80 flex-shrink-0 border-r border-vw-border bg-vw-surface1 flex flex-col z-10 transition-all">
        {sidebar}
      </aside>

      {/* Center Panel */}
      <main className="flex-1 min-w-0 flex flex-col bg-vw-bg relative shadow-centerPanel transition-all">
        {centerContent}
      </main>

      {/* Right Panel */}
      <aside className="w-96 flex-shrink-0 border-l border-vw-border bg-vw-surface1 flex flex-col z-10 transition-all">
        {rightPanel}
      </aside>
    </div>
  );
}

// ----------------------------------------------------------------------
// 2. Sidebar / Room List
// ----------------------------------------------------------------------
export function SidebarContent() {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-vw-border flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-vw-accent" />
          VeriWire
        </h1>
        <button className="p-1.5 rounded-md hover:bg-vw-surface2 text-vw-muted hover:text-white transition-colors cursor-pointer">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="px-4 py-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-vw-muted" />
          <input
            type="text"
            placeholder="Search rumours..."
            className="w-full bg-vw-surface2 border border-vw-border rounded-lg pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-vw-accent/50 focus:ring-1 focus:ring-vw-accent/50 transition-all placeholder:text-vw-muted"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <RoomCard
          active
          id="VWRM-0042"
          title="CEO stepping down amid fraud allegations"
          status="investigating"
          time="2m ago"
        />
        <RoomCard
          id="VWRM-0089"
          title="New AI model achieves AGI benchmarks in leak"
          status="pending_verdict"
          time="1h ago"
        />
        <RoomCard
          id="VWRM-0091"
          title="Major tech firm acquiring rival for $50B"
          status="closed"
          time="3d ago"
        />
      </div>
      
      <div className="p-4 border-t border-vw-border flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-vw-surface3 border border-vw-border flex items-center justify-center text-xs font-mono font-bold">
          US
        </div>
        <div className="flex-1 truncate text-sm text-vw-text">investigator_01</div>
      </div>
    </div>
  );
}

function RoomCard({ active, id, title, status, time }: { active?: boolean; id: string; title: string; status: 'investigating' | 'pending_verdict' | 'closed'; time: string; }) {
  return (
    <button
      className={cn(
        "w-full text-left p-3 rounded-xl border transition-all duration-200 group flex flex-col gap-2",
        active 
          ? "bg-vw-surface3 border-vw-accent/30 shadow-[0_0_15px_rgba(45,212,191,0.05)]" 
          : "bg-transparent border-transparent hover:bg-vw-surface2 hover:border-vw-border cursor-pointer"
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-mono">
        <span className={cn("font-medium", active ? "text-vw-accent" : "text-vw-muted")}>{id}</span>
        <span className="text-vw-muted/60">{time}</span>
      </div>
      <h3 className="text-sm font-medium leading-snug line-clamp-2 text-white/90 group-hover:text-white">
        {title}
      </h3>
      <div className="flex items-center gap-2 mt-1 w-full justify-between">
         <StatusChip status={status} />
         {active && <div className="w-1.5 h-1.5 rounded-full bg-vw-accent animate-pulse" />}
      </div>
    </button>
  );
}

function StatusChip({ status }: { status: 'investigating' | 'pending_verdict' | 'closed' }) {
  const styles = {
    investigating: "bg-vw-accent/10 text-vw-accent border-vw-accent/20",
    pending_verdict: "bg-vw-pending/10 text-vw-pending border-vw-pending/20",
    closed: "bg-vw-closed/10 text-vw-closed border-vw-closed/20"
  };
  
  const labels = {
    investigating: "Investigating",
    pending_verdict: "Pending Verdict",
    closed: "Closed"
  };

  return (
    <span className={cn("text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md border", styles[status])}>
      {labels[status]}
    </span>
  );
}

// ----------------------------------------------------------------------
// 3. Center Panel / Live Room
// ----------------------------------------------------------------------
export function CenterContent() {
  return (
    <div className="flex flex-col h-full bg-vw-bg isolate">
      {/* Header Dossier */}
      <header className="px-6 py-5 border-b border-vw-border bg-vw-surface1/50 backdrop-blur-xl z-20 flex-shrink-0">
        <div className="flex items-start justify-between gap-4 mb-3">
          <StatusChip status="investigating" />
          <div className="flex items-center gap-3 text-xs text-vw-muted font-mono">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Started 2h ago</span>
            <span>ID: VWRM-0042</span>
          </div>
        </div>
        <h2 className="text-2xl font-bold text-white tracking-tight leading-tight">
          CEO stepping down amid fraud allegations
        </h2>
        <a href="#" className="mt-2 inline-flex items-center gap-1.5 text-sm text-vw-accent hover:text-vw-accent/80 transition-colors">
          <ArrowRight className="w-3.5 h-3.5" />
          Source: https://viral-news-site.biz/ceo-scandal
        </a>
      </header>

      {/* Discussion Thread */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="flex flex-col justify-center items-center py-10 opacity-60 pointer-events-none">
          <div className="w-px h-10 bg-gradient-to-b from-transparent to-vw-accent/50 mb-4" />
          <p className="text-xs font-mono uppercase tracking-widest text-vw-accent">Investigation Opened</p>
        </div>
        
        <ChatMessage author="investigator_88" time="10:42 AM">
          I&apos;ve looked into the latest SEC filings, nothing matches this claim yet.
        </ChatMessage>
        
        <ChatMessage author="Agent Zero" time="10:43 AM" isAgent>
          The domain provided was registered 3 days ago. No historic snapshot available. Pattern indicates high likelihood of unverified rumor. 
        </ChatMessage>
        
        <ChatMessage author="truth_seeker" time="10:45 AM" proof={{ title: "SEC Form 8-K", stance: "refutes" }}>
          Wait, I just pulled the latest 8-K from the official relations page. They actually reaffirmed the CEO&apos;s 4-year plan. 
        </ChatMessage>
      </div>

      {/* Composer */}
      <div className="p-4 bg-vw-surface1/80 border-t border-vw-border backdrop-blur-md">
        <div className="relative flex items-end gap-2 bg-vw-surface2 rounded-xl border border-vw-border focus-within:border-vw-accent/50 focus-within:ring-1 focus-within:ring-vw-accent/50 transition-all p-2">
          <button className="p-2 text-vw-muted hover:text-white transition-colors cursor-pointer rounded-lg hover:bg-vw-surface3">
            <Plus className="w-5 h-5" />
          </button>
          
          <textarea
            className="flex-1 max-h-32 min-h-[40px] bg-transparent resize-none outline-none py-2 text-sm placeholder:text-vw-muted"
            placeholder="Discuss or upload proof..."
            rows={1}
          />
          
          <button className="px-4 py-2 bg-vw-accent/10 hover:bg-vw-accent/20 text-vw-accent font-medium rounded-lg text-sm transition-colors tabular-nums tracking-wide flex items-center gap-2 cursor-pointer border border-vw-accent/20">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ author, time, children, isAgent, proof }: { author: string; time: string; children: React.ReactNode; isAgent?: boolean; proof?: { title: string, stance: 'supports' | 'refutes' | 'context' } }) {
  return (
    <div className={cn("flex gap-4 group", isAgent && "opacity-90")}>
      <div className={cn(
        "w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center font-bold text-xs ring-1 ring-inset",
        isAgent 
          ? "bg-vw-accent/10 text-vw-accent ring-vw-accent/30 shadow-[0_0_12px_rgba(45,212,191,0.15)]" 
          : "bg-vw-surface3 text-vw-muted ring-vw-border"
      )}>
        {author.slice(0,2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <div className="flex items-baseline gap-2 mb-1">
          <span className={cn("text-sm font-semibold", isAgent ? "text-vw-accent" : "text-vw-text")}>{author}</span>
          <span className="text-[10px] text-vw-muted font-mono">{time}</span>
        </div>
        <div className="text-sm leading-relaxed text-vw-text/90">
          {children}
        </div>
        
        {proof && (
          <div className="mt-3 inline-flex items-center gap-3 p-2.5 pr-4 rounded-lg bg-vw-surface2 border border-vw-border cursor-pointer hover:border-vw-muted transition-colors">
            <div className={cn(
              "p-1.5 rounded-md",
              proof.stance === 'supports' && "bg-vw-supports/10 text-vw-supports",
              proof.stance === 'refutes' && "bg-vw-refutes/10 text-vw-refutes",
              proof.stance === 'context' && "bg-vw-context/10 text-vw-context",
            )}>
              <FileCheck2 className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xs font-medium text-white">{proof.title}</p>
              <p className="text-[10px] uppercase font-mono mt-0.5 tracking-wider text-vw-muted">Proof • {proof.stance}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// 4. Right Panel / Evidence & clarity card
// ----------------------------------------------------------------------
export function RightContent() {
  return (
    <div className="flex flex-col h-full bg-vw-surface1">
      <div className="p-4 border-b border-vw-border">
        <h3 className="text-sm font-semibold text-white/90 uppercase tracking-widest font-mono flex items-center gap-2">
          <List className="w-4 h-4 text-vw-muted" />
          Evidence Stack
        </h3>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Evidence Items */}
        <EvidenceCard stance="refutes" title="SEC Form 8-K Reaffirmation" url="sec.gov/filings" credibility="HIGH" />
        <EvidenceCard stance="context" title="Domain Registration Whois" url="icann.org/lookup" credibility="MEDIUM" />
        
        {/* Weighted Poll Module */}
        <div className="mt-8 p-4 rounded-xl border border-vw-border bg-vw-surface2">
          <h4 className="text-xs font-mono uppercase tracking-widest text-vw-muted mb-4">Current Verdict Direction</h4>
          
          <div className="space-y-3 relative">
            <PollBar label="True" percent={12} type="supports" />
            <PollBar label="False" percent={78} type="refutes" />
            <PollBar label="Unclear" percent={10} type="context" />
          </div>
          
          <button className="mt-5 w-full py-2 bg-vw-surface3 hover:bg-vw-border text-white text-sm font-medium rounded-lg transition-colors cursor-pointer border border-vw-border">
            Lock Verdict
          </button>
        </div>
        
        {/* Clarity Card Preview (Empty State / Generating) */}
        <div className="mt-8">
           <h4 className="text-xs font-mono uppercase tracking-widest text-vw-muted mb-4">Clarity Card (Draft)</h4>
           <div className="rounded-xl border border-vw-border bg-gradient-to-b from-vw-surface2 to-vw-surface1 p-5 shadow-card relative overflow-hidden group">
             
             {/* Glow effect */}
             <div className="absolute top-0 right-0 w-32 h-32 bg-vw-refutes/10 rounded-full blur-3xl" />
             
             <div className="relative z-10">
               <div className="flex items-center gap-2 text-vw-refutes mb-3">
                 <XCircle className="w-5 h-5" />
                 <span className="text-sm font-bold uppercase tracking-widest">False / Debunked</span>
               </div>
               
               <p className="text-sm text-white/90 leading-relaxed font-medium mb-4">
                 The claim that the CEO is stepping down due to fraud allegations is unsupported by official filings and appears to originate from an unverified, newly registered domain.
               </p>
               
               <div className="pt-4 border-t border-vw-border/50 flex flex-col gap-1 text-[10px] uppercase font-mono text-vw-muted">
                 <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-vw-supports" /> 1 Validated Proof</span>
                 <span className="flex items-center gap-1.5"><HelpCircle className="w-3 h-3 text-vw-context" /> 1 Context Item</span>
               </div>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceCard({ stance, title, url, credibility }: { stance: 'supports'|'refutes'|'context', title: string, url: string, credibility: string }) {
  const colors = {
    supports: "text-vw-supports bg-vw-supports/10 border-vw-supports/20",
    refutes: "text-vw-refutes bg-vw-refutes/10 border-vw-refutes/20",
    context: "text-vw-context bg-vw-context/10 border-vw-context/20"
  };
  
  return (
    <div className="p-3 rounded-lg border border-vw-border bg-vw-surface2 hover:border-vw-muted transition-colors cursor-pointer">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={cn("text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border", colors[stance])}>
          {stance}
        </span>
        <span className="text-[9px] font-mono text-vw-muted tracking-wider">
          {credibility}
        </span>
      </div>
      <p className="text-sm font-medium text-white line-clamp-2 leading-snug">{title}</p>
      <p className="text-xs text-vw-muted mt-1 truncate font-mono">{url}</p>
    </div>
  );
}

function PollBar({ label, percent, type }: { label: string; percent: number; type: 'supports'|'refutes'|'context' }) {
  const bgClasses = {
    supports: "bg-vw-supports",
    refutes: "bg-vw-refutes",
    context: "bg-vw-context"
  };
  
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="w-14 text-xs font-medium text-vw-text text-right">{label}</div>
      <div className="flex-1 h-2 rounded-full bg-vw-surface3 overflow-hidden">
        <div 
          className={cn("h-full rounded-full transition-all duration-1000 ease-out", bgClasses[type])} 
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="w-8 text-xs font-mono text-vw-muted">{percent}%</div>
    </div>
  );
}
