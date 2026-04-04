"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type RoomSummary = {
  id: string;
  claimRaw: string;
  claimNormalized: string;
  status: "OPEN" | "INVESTIGATING" | "PENDING_VERDICT" | "CLOSED";
  verdict: "TRUE" | "FALSE" | "UNCLEAR" | null;
  confidence: "LOW" | "MEDIUM" | "HIGH" | null;
  heatScore: number;
  recurrenceCount: number;
  createdAt: string;
  closedAt: string | null;
  clarityCardUrl: string | null;
  voiceBriefUrl: string | null;
  piiFlagged: boolean;
  members: Array<{
    user: {
      id: string;
      name: string | null;
      image: string | null;
      contributorScore: number;
    };
  }>;
};

type RoomDetail = RoomSummary & {
  tags: string[];
  evidence: Array<{
    id: string;
    submittedBy: string;
    sourceUrl: string;
    sourceName: string;
    sourceFaviconUrl: string | null;
    snippet: string;
    stance: "SUPPORTS" | "REFUTES" | "CONTEXT";
    type: "OBSERVATION" | "INFERENCE" | "SPECULATION";
    agentConfidence: number | null;
    disputedBy: string[];
    createdAt: string;
  }>;
  votes: Array<{
    id: string;
    verdict: "TRUE" | "FALSE" | "UNCLEAR";
    weight: number;
    user: {
      id: string;
      name: string | null;
      contributorScore: number;
      image: string | null;
    };
  }>;
  agentEvents: Array<{
    id: string;
    step: string;
    detail: string;
    progress: number;
    blocked: boolean;
    createdAt: string;
  }>;
  clarityCard: {
    id: string;
    claimShort: string;
    verdict: string;
    confidence: string;
    evidenceBullets: string[];
    rebuttalText: string;
    imageUrl: string;
    audioUrl: string | null;
    qrUrl: string;
  } | null;
  checklistTasks: Array<{
    id: string;
    title: string;
    status: "PENDING" | "DONE";
  }>;
};

type Weighted = {
  totals: {
    TRUE: number;
    FALSE: number;
    UNCLEAR: number;
  };
  percentages: {
    TRUE: number;
    FALSE: number;
    UNCLEAR: number;
  };
};

type RecurrenceBanner = {
  originalRoomId: string;
  daysAgo: number;
  resurfacedCount: number;
  originalVerdict: "TRUE" | "FALSE" | "UNCLEAR" | null;
} | null;

const statusClassMap: Record<RoomSummary["status"], string> = {
  OPEN: "text-vv-slate border-vv-slate/70",
  INVESTIGATING: "text-vv-amber border-vv-amber/70",
  PENDING_VERDICT: "text-vv-accent border-vv-accent/70",
  CLOSED: "text-vv-emerald border-vv-emerald/70"
};

const stanceClassMap: Record<"SUPPORTS" | "REFUTES" | "CONTEXT", string> = {
  SUPPORTS: "border-vv-emerald/50 text-vv-emerald",
  REFUTES: "border-vv-crimson/50 text-vv-crimson",
  CONTEXT: "border-vv-slate/60 text-vv-slate"
};

function statusTint(room: RoomSummary | RoomDetail) {
  if (room.status !== "CLOSED") {
    return "border-vv-amber/60";
  }

  if (room.verdict === "TRUE") {
    return "border-vv-emerald/60";
  }

  if (room.verdict === "FALSE") {
    return "border-vv-crimson/60";
  }

  return "border-vv-slate/60";
}

function formatAgo(dateIso: string) {
  const delta = Date.now() - new Date(dateIso).getTime();
  const mins = Math.floor(delta / 60000);

  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function readJson<T>(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const data = await res.json();

  if (!res.ok) {
    const message = data?.detail ?? data?.error ?? "Request failed";
    throw new Error(message);
  }

  return data as T;
}

export function VeriWireApp({ initialRoomId }: { initialRoomId: string | null }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(initialRoomId);
  const [activeRoom, setActiveRoom] = useState<RoomDetail | null>(null);
  const [weighted, setWeighted] = useState<Weighted | null>(null);
  const [recurrenceBanner, setRecurrenceBanner] = useState<RecurrenceBanner>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimText, setClaimText] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceStance, setEvidenceStance] = useState<"SUPPORTS" | "REFUTES" | "CONTEXT">("REFUTES");
  const [voteVerdict, setVoteVerdict] = useState<"TRUE" | "FALSE" | "UNCLEAR">("FALSE");
  const [mobileTab, setMobileTab] = useState<"FEED" | "ROOM" | "AGENT" | "CARD">("ROOM");

  async function loadRooms() {
    const data = await readJson<{ rooms: RoomSummary[] }>("/api/rooms");
    setRooms(data.rooms);

    if (!activeRoomId && data.rooms.length > 0) {
      setActiveRoomId(data.rooms[0].id);
    }
  }

  async function loadRoom(roomId: string) {
    const data = await readJson<{ room: RoomDetail; weighted: Weighted; recurrenceBanner: RecurrenceBanner }>(
      `/api/rooms/${roomId}`
    );
    setActiveRoom(data.room);
    setWeighted(data.weighted);
    setRecurrenceBanner(data.recurrenceBanner);
  }

  async function refreshAll() {
    try {
      setError(null);
      await loadRooms();
      if (activeRoomId) {
        await loadRoom(activeRoomId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    }
  }

  useEffect(() => {
    refreshAll();
    const timer = setInterval(() => {
      refreshAll();
    }, 20000);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeRoomId) return;
    loadRoom(activeRoomId).catch((err) => setError(err instanceof Error ? err.message : "Failed to load room"));
  }, [activeRoomId]);

  useEffect(() => {
    if (!activeRoomId) {
      return;
    }

    const stream = new EventSource(`/api/rooms/${activeRoomId}/stream`);

    const refreshRoom = () => {
      loadRoom(activeRoomId).catch(() => {
        // Stream refresh failures should not tear down UI state.
      });
      loadRooms().catch(() => {
        // Feed refresh failures are ignored until next server event.
      });
    };

    stream.addEventListener("room.update", refreshRoom);

    stream.addEventListener("stream.error", () => {
      setError("Live stream interrupted. Reconnecting...");
    });

    stream.onerror = () => {
      setError("Realtime connection dropped. Falling back to periodic refresh.");
    };

    return () => {
      stream.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId]);

  const latestAgentEvent = useMemo(() => {
    if (!activeRoom?.agentEvents?.length) {
      return null;
    }

    return activeRoom.agentEvents[activeRoom.agentEvents.length - 1];
  }, [activeRoom]);

  async function submitClaim() {
    if (!claimText.trim()) return;

    try {
      setBusy(true);
      setError(null);
      const data = await readJson<{ room: RoomSummary }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({
          claimText: claimText.trim(),
          sourceType: "TEXT"
        })
      });

      setClaimText("");
      setActiveRoomId(data.room.id);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit claim");
    } finally {
      setBusy(false);
    }
  }

  async function submitEvidence() {
    if (!activeRoomId || !evidenceUrl.trim()) return;

    try {
      setBusy(true);
      setError(null);
      await readJson(`/api/rooms/${activeRoomId}/evidence`, {
        method: "POST",
        body: JSON.stringify({
          sourceUrl: evidenceUrl.trim(),
          stance: evidenceStance
        })
      });
      setEvidenceUrl("");
      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit evidence");
    } finally {
      setBusy(false);
    }
  }

  async function castVote() {
    if (!activeRoomId) return;

    try {
      setBusy(true);
      setError(null);
      await readJson(`/api/rooms/${activeRoomId}/vote`, {
        method: "POST",
        body: JSON.stringify({
          verdict: voteVerdict
        })
      });

      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to vote");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(nextStatus: "INVESTIGATING" | "PENDING_VERDICT" | "CLOSED") {
    if (!activeRoomId) return;

    try {
      setBusy(true);
      setError(null);
      await readJson(`/api/rooms/${activeRoomId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: nextStatus })
      });

      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  }

  async function generateCard() {
    if (!activeRoomId) return;

    try {
      setBusy(true);
      setError(null);
      await readJson(`/api/rooms/${activeRoomId}/clarity-card`, {
        method: "POST"
      });
      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate clarity card");
    } finally {
      setBusy(false);
    }
  }

  async function disputeAgentEvidence(evidenceId: string) {
    if (!activeRoomId) return;

    try {
      setBusy(true);
      setError(null);
      await readJson(`/api/rooms/${activeRoomId}/evidence/${evidenceId}/dispute`, {
        method: "POST"
      });

      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dispute evidence");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen p-3 md:p-5">
      <div className="mx-auto mb-3 flex max-w-[1460px] items-center justify-between border border-white/10 bg-vv-surface1/90 px-4 py-3 animate-rise">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-vv-accent">VeriWire</p>
          <p className="text-sm text-vv-muted">Collaborative misinformation resolution rooms</p>
        </div>
        <div className="hidden text-right font-mono text-xs text-vv-muted md:block">
          <p>DEMO MODE ENABLED</p>
          <p>Observer session auto-resolved</p>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1460px] grid-cols-1 gap-3 md:grid-cols-[240px_1fr_300px] animate-rise">
        <aside className={cn("card-shell hidden overflow-hidden md:block")}> 
          <div className="border-b border-white/10 px-3 py-2 font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Rumour Feed</div>
          <div className="max-h-[calc(100vh-210px)] overflow-y-auto">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                className={cn(
                  "w-full border-b border-white/5 px-3 py-3 text-left transition hover:bg-white/[0.03]",
                  activeRoomId === room.id && "feed-item-active bg-white/[0.02]"
                )}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] tracking-[0.12em] text-vv-muted">{room.id}</span>
                  <span className={cn("status-pill", statusClassMap[room.status])}>{room.status}</span>
                </div>
                <p className="line-clamp-1 text-xs text-vv-text">{room.claimRaw}</p>
                <div className="mt-2 flex items-center justify-between">
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-vv-accent animate-pulseBar" style={{ width: `${Math.min(100, room.heatScore * 100)}%` }} />
                  </div>
                  <span className="font-mono text-[11px] text-vv-muted">{formatAgo(room.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="card-shell min-h-[72vh] overflow-hidden">
          {activeRoom ? (
            <>
              <div className={cn("border-l-4 bg-vv-surface2 px-4 py-4", statusTint(activeRoom))}>
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-vv-amber">Claim Docket</p>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-vv-muted">{activeRoom.id}</span>
                    <span className={cn("status-pill", statusClassMap[activeRoom.status])}>{activeRoom.status}</span>
                  </div>
                </div>
                <p className="font-mono text-lg font-semibold leading-tight text-vv-text">{activeRoom.claimRaw}</p>
                <p className="mt-2 text-xs text-vv-muted">Immutable claim record</p>
              </div>

              {recurrenceBanner ? (
                <div className="border-y border-vv-amber/45 bg-vv-amber/10 px-4 py-2 text-xs text-vv-amber">
                  This claim was {recurrenceBanner.originalVerdict?.toLowerCase() ?? "reviewed"} {recurrenceBanner.daysAgo} days ago.
                  It resurfaced {recurrenceBanner.resurfacedCount} times.
                  <a
                    className="ml-1 font-semibold underline"
                    href={`/?room=${recurrenceBanner.originalRoomId}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setActiveRoomId(recurrenceBanner.originalRoomId);
                    }}
                  >
                    Open original room
                  </a>
                </div>
              ) : null}

              {activeRoom.status === "CLOSED" ? (
                <div className="border-b border-white/10 bg-vv-surface3/70 px-4 py-2 text-sm text-vv-muted">
                  This room is closed. Verdict: {activeRoom.verdict ?? "UNCLEAR"}.
                </div>
              ) : null}

              <div className="max-h-[50vh] space-y-3 overflow-y-auto px-3 py-3">
                {activeRoom.evidence.map((item) => {
                  const isAgent = item.submittedBy === "AGENT";
                  const disputed = item.disputedBy.length >= 2;

                  return (
                    <article
                      key={item.id}
                      className={cn(
                        "border border-white/10 bg-vv-surface2 p-3",
                        isAgent && "border-l-2 border-l-vv-agent shadow-agent",
                        disputed && "opacity-60"
                      )}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono text-vv-muted">{isAgent ? "[AGENT]" : item.submittedBy.slice(0, 8)}</span>
                        <span className={cn("status-pill", stanceClassMap[item.stance])}>{item.stance}</span>
                        <span className="status-pill border-white/20 text-vv-muted">{item.type}</span>
                        <a className="truncate text-vv-accent hover:underline" href={item.sourceUrl} target="_blank" rel="noreferrer">
                          {item.sourceName}
                        </a>
                        {isAgent ? (
                          <button
                            onClick={() => disputeAgentEvidence(item.id)}
                            disabled={busy}
                            className="status-pill border-vv-amber/50 text-vv-amber hover:bg-vv-amber/10 disabled:opacity-40"
                          >
                            Dispute ({item.disputedBy.length})
                          </button>
                        ) : null}
                      </div>
                      <p className={cn("text-sm leading-relaxed text-vv-text", disputed && "line-through")}>{item.snippet}</p>
                    </article>
                  );
                })}
              </div>

              <div className="border-t border-white/10 bg-vv-surface1 p-3">
                <p className="mb-2 text-xs uppercase tracking-[0.14em] text-vv-muted">Submit Evidence</p>
                <div className="grid gap-2 md:grid-cols-[1fr_160px_120px]">
                  <input
                    value={evidenceUrl}
                    onChange={(event) => setEvidenceUrl(event.target.value)}
                    className="w-full border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
                    placeholder="https://source.url"
                    disabled={activeRoom.status === "CLOSED" || busy}
                  />
                  <select
                    value={evidenceStance}
                    onChange={(event) => setEvidenceStance(event.target.value as "SUPPORTS" | "REFUTES" | "CONTEXT")}
                    className="border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
                    disabled={activeRoom.status === "CLOSED" || busy}
                  >
                    <option value="SUPPORTS">SUPPORTS</option>
                    <option value="REFUTES">REFUTES</option>
                    <option value="CONTEXT">CONTEXT</option>
                  </select>
                  <button
                    onClick={submitEvidence}
                    disabled={activeRoom.status === "CLOSED" || busy}
                    className="border border-vv-accent/70 bg-vv-accent/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent transition hover:bg-vv-accent/20 disabled:opacity-40"
                  >
                    Add Source
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-[70vh] items-center justify-center text-vv-muted">No active room selected</div>
          )}
        </section>

        <aside className="card-shell hidden flex-col md:flex">
          <div className="border-b border-white/10 p-3">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Intelligence Panel</p>
          </div>

          <div className="space-y-3 p-3">
            <section className="border border-white/10 bg-vv-surface2 p-3">
              <p className="mb-2 text-xs uppercase tracking-[0.16em] text-vv-muted">Agent Status</p>
              {latestAgentEvent ? (
                <>
                  <p className="font-mono text-xs text-vv-accent">{latestAgentEvent.step}</p>
                  <p className="mt-2 text-sm text-vv-text">{latestAgentEvent.detail}</p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-vv-agent" style={{ width: `${latestAgentEvent.progress}%` }} />
                  </div>
                </>
              ) : (
                <p className="text-sm text-vv-muted">Waiting for agent events</p>
              )}
            </section>

            <section className="border border-white/10 bg-vv-surface2 p-3">
              <p className="mb-3 text-xs uppercase tracking-[0.16em] text-vv-muted">Weighted Poll</p>
              <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
                {(["TRUE", "FALSE", "UNCLEAR"] as const).map((verdict) => (
                  <div key={verdict} className="border border-white/10 bg-vv-surface3 px-2 py-2">
                    <p className="font-mono text-[10px] text-vv-muted">{verdict}</p>
                    <p className="mt-1 text-sm text-vv-text">{weighted?.percentages[verdict] ?? 0}%</p>
                  </div>
                ))}
              </div>

              <div className="mb-3 flex min-h-[78px] flex-wrap items-end gap-2">
                {(activeRoom?.votes ?? []).map((vote) => (
                  <div
                    key={vote.id}
                    className={cn(
                      "rounded-full border",
                      vote.verdict === "TRUE" && "border-vv-emerald/60 bg-vv-emerald/15",
                      vote.verdict === "FALSE" && "border-vv-crimson/60 bg-vv-crimson/15",
                      vote.verdict === "UNCLEAR" && "border-vv-slate/60 bg-vv-slate/15"
                    )}
                    style={{
                      width: `${24 + Math.min(52, vote.weight * 15)}px`,
                      height: `${24 + Math.min(52, vote.weight * 15)}px`
                    }}
                    title={`${vote.user.name ?? "User"}: ${vote.verdict} (${vote.weight.toFixed(2)})`}
                  />
                ))}
              </div>

              <div className="grid grid-cols-[1fr_100px] gap-2">
                <select
                  value={voteVerdict}
                  onChange={(event) => setVoteVerdict(event.target.value as "TRUE" | "FALSE" | "UNCLEAR")}
                  className="border border-white/10 bg-vv-surface3 px-2 py-2 text-xs outline-none focus:border-vv-accent"
                  disabled={activeRoom?.status !== "PENDING_VERDICT" || busy}
                >
                  <option value="TRUE">TRUE</option>
                  <option value="FALSE">FALSE</option>
                  <option value="UNCLEAR">UNCLEAR</option>
                </select>
                <button
                  onClick={castVote}
                  disabled={activeRoom?.status !== "PENDING_VERDICT" || busy}
                  className="border border-vv-accent/70 bg-vv-accent/10 px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-vv-accent disabled:opacity-40"
                >
                  Vote
                </button>
              </div>
            </section>

            <section className="border border-white/10 bg-vv-surface2 p-3">
              <button
                onClick={generateCard}
                disabled={!activeRoom || activeRoom.status !== "CLOSED" || busy}
                className="w-full border border-vv-accent/80 bg-vv-accent/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent shadow-[0_0_18px_rgba(45,212,191,0.25)] disabled:opacity-40"
              >
                Generate Clarity Card
              </button>

              <div className="mt-3 rounded-[28px] border border-white/10 bg-vv-surface3 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-vv-muted">Card Preview</p>
                {activeRoom?.clarityCard ? (
                  <div className="mt-3 space-y-2 text-sm">
                    <p className="font-mono text-vv-text">{activeRoom.clarityCard.claimShort}</p>
                    <p className="status-pill inline-flex border-vv-accent/60 text-vv-accent">{activeRoom.clarityCard.verdict}</p>
                    <ul className="space-y-1 text-xs text-vv-muted">
                      {activeRoom.clarityCard.evidenceBullets.slice(0, 2).map((bullet, index) => (
                        <li key={`${index}-${bullet}`}>- {bullet}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-vv-muted">Card appears here once generated.</p>
                )}
              </div>
            </section>
          </div>
        </aside>
      </div>

      <div className="mx-auto mt-3 max-w-[1460px] rounded border border-white/10 bg-vv-surface1 p-3 md:hidden">
        <div className="mb-2 grid grid-cols-4 gap-2">
          {(["FEED", "ROOM", "AGENT", "CARD"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={cn(
                "border px-2 py-2 text-[11px] font-mono uppercase tracking-[0.12em]",
                mobileTab === tab ? "border-vv-accent text-vv-accent" : "border-white/10 text-vv-muted"
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        {mobileTab === "FEED" ? (
          <div className="max-h-[46vh] space-y-2 overflow-y-auto">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => {
                  setActiveRoomId(room.id);
                  setMobileTab("ROOM");
                }}
                className="w-full border border-white/10 px-3 py-2 text-left"
              >
                <p className="font-mono text-[11px] text-vv-muted">{room.id}</p>
                <p className="line-clamp-1 text-sm text-vv-text">{room.claimRaw}</p>
              </button>
            ))}
          </div>
        ) : null}

        {mobileTab === "ROOM" && activeRoom ? (
          <div className="space-y-2 text-sm">
            <p className="font-mono text-vv-text">{activeRoom.claimRaw}</p>
            <p className="text-xs text-vv-muted">{activeRoom.evidence.length} evidence items</p>
          </div>
        ) : null}

        {mobileTab === "AGENT" ? (
          <div className="text-sm text-vv-muted">{latestAgentEvent?.detail ?? "No agent update yet"}</div>
        ) : null}

        {mobileTab === "CARD" ? (
          <div className="text-sm text-vv-muted">{activeRoom?.clarityCard?.rebuttalText ?? "Clarity card not generated yet."}</div>
        ) : null}
      </div>

      <div className="mx-auto mt-3 flex max-w-[1460px] gap-2">
        <input
          value={claimText}
          onChange={(event) => setClaimText(event.target.value)}
          maxLength={1000}
          className="w-full border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
          placeholder="Submit viral claim text"
          disabled={busy}
        />
        <button
          onClick={submitClaim}
          disabled={busy || !claimText.trim()}
          className="border border-vv-accent/70 bg-vv-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Room"}
        </button>
      </div>

      {activeRoom ? (
        <div className="mx-auto mt-3 flex max-w-[1460px] flex-wrap gap-2">
          <button
            onClick={() => setStatus("INVESTIGATING")}
            disabled={busy || activeRoom.status !== "OPEN"}
            className="border border-vv-amber/50 px-3 py-1.5 text-xs text-vv-amber disabled:opacity-40"
          >
            Set Investigating
          </button>
          <button
            onClick={() => setStatus("PENDING_VERDICT")}
            disabled={busy || activeRoom.status !== "INVESTIGATING"}
            className="border border-vv-accent/50 px-3 py-1.5 text-xs text-vv-accent disabled:opacity-40"
          >
            Open Poll
          </button>
          <button
            onClick={() => setStatus("CLOSED")}
            disabled={busy || activeRoom.status !== "PENDING_VERDICT"}
            className="border border-vv-emerald/50 px-3 py-1.5 text-xs text-vv-emerald disabled:opacity-40"
          >
            Close Room
          </button>
        </div>
      ) : null}

      {error ? <p className="mx-auto mt-3 max-w-[1460px] text-sm text-vv-crimson">{error}</p> : null}
    </main>
  );
}
