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
  messages: Array<{
    id: string;
    body: string;
    kind: "CHAT" | "PROOF_NOTE";
    evidenceId: string | null;
    createdAt: string;
    user: { id: string; name: string | null; image: string | null };
    evidence: {
      id: string;
      sourceName: string;
      sourceUrl: string;
      snippet: string;
      stance: "SUPPORTS" | "REFUTES" | "CONTEXT";
    } | null;
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

type RoomsResponse = {
  rooms: RoomSummary[];
  demoMode: boolean;
  viewerRole: "OBSERVER" | "CONTRIBUTOR";
};

type ViewerResponse = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    role: "USER" | "MODERATOR" | "ADMIN";
  };
  demoMode: boolean;
  demoAccountId: string | null;
  demoReadOnly: boolean;
};

type RoomPatchEvent = {
  roomId: string;
  reason: "initial-sync" | "delta";
  marker: {
    latestEvidenceAt: string | null;
    latestVoteAt: string | null;
    latestAgentEventAt: string | null;
    latestAuditAt: string | null;
    latestMessageAt?: string | null;
  };
  snapshot: {
    room: RoomDetail | null;
    roomSummary: RoomSummary | null;
    weighted: Weighted;
    recurrenceBanner: RecurrenceBanner;
  } | null;
  timestamp: string;
};

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

function sortRoomsByPriority(items: RoomSummary[]) {
  return [...items].sort((a, b) => {
    if (b.heatScore !== a.heatScore) {
      return b.heatScore - a.heatScore;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

class FetchJsonError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
  }
}

async function readJson<T>(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const message =
      (typeof payload?.detail === "string" && payload.detail) ||
      (typeof payload?.error === "string" && payload.error) ||
      "Request failed";
    throw new FetchJsonError(res.status, message);
  }

  return data as T;
}

function DemoLayoutSkeleton() {
  return (
    <div className="mx-auto grid max-w-[1460px] grid-cols-1 gap-4 md:grid-cols-[280px_1fr_360px] animate-rise">
      <aside className="card-shell hidden overflow-hidden p-3 md:block">
        <div className="h-12 rounded-lg border border-white/10 bg-white/[0.02]" />
        <div className="mt-3 space-y-2">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={`feed-skeleton-${index}`} className="h-16 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
          ))}
        </div>
      </aside>

      <section className="card-shell min-h-[72vh] p-4">
        <div className="h-24 animate-pulse rounded-lg border border-white/10 bg-white/[0.05]" />
        <div className="mt-3 h-10 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
        <div className="mt-3 space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={`thread-skeleton-${index}`} className="h-20 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
          ))}
        </div>
        <div className="mt-3 h-16 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
      </section>

      <aside className="card-shell hidden p-3 md:block">
        <div className="h-24 animate-pulse rounded-lg border border-white/10 bg-white/[0.05]" />
        <div className="mt-3 h-36 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
        <div className="mt-3 h-52 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
      </aside>
    </div>
  );
}

export function VeriWireApp({ initialRoomId }: { initialRoomId: string | null }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(initialRoomId);
  const [activeRoom, setActiveRoom] = useState<RoomDetail | null>(null);
  const [weighted, setWeighted] = useState<Weighted | null>(null);
  const [recurrenceBanner, setRecurrenceBanner] = useState<RecurrenceBanner>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [currentUser, setCurrentUser] = useState<ViewerResponse["user"] | null>(null);
  const [demoAccountId, setDemoAccountId] = useState<string | null>(null);
  const [viewerRole, setViewerRole] = useState<"OBSERVER" | "CONTRIBUTOR">("CONTRIBUTOR");
  const [showDemoBanner, setShowDemoBanner] = useState(true);
  const [inlineMessage, setInlineMessage] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimText, setClaimText] = useState("");
  const [claimUrl, setClaimUrl] = useState("");
  const [claimImage, setClaimImage] = useState<File | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceStance, setEvidenceStance] = useState<"SUPPORTS" | "REFUTES" | "CONTEXT">("REFUTES");
  const [voteVerdict, setVoteVerdict] = useState<"TRUE" | "FALSE" | "UNCLEAR">("FALSE");
  const [mobileTab, setMobileTab] = useState<"FEED" | "ROOM" | "CHAT" | "AGENT" | "CARD">("ROOM");
  const [chatDraft, setChatDraft] = useState("");
  const [proofThreadEvidenceId, setProofThreadEvidenceId] = useState("");

  const observerReadOnly = demoMode && viewerRole === "OBSERVER";

  const blockObserverAction = () => {
    if (!observerReadOnly) {
      return false;
    }

    setInlineMessage("This action is blocked for the current session.");
    return true;
  };

  const resolveDefaultRoomId = (items: RoomSummary[]) => {
    if (initialRoomId) {
      return initialRoomId;
    }

    const preferred =
      items.find((room) => room.id === "VWRM0002") ??
      items.find((room) => room.status === "PENDING_VERDICT" && room.recurrenceCount > 0) ??
      items[0] ??
      null;

    return preferred?.id ?? null;
  };

  async function loadRooms() {
    const data = await readJson<RoomsResponse>("/api/rooms");
    setRooms(sortRoomsByPriority(data.rooms));
    setDemoMode(data.demoMode);
    setViewerRole(data.viewerRole);
    return data;
  }

  async function loadViewer() {
    const data = await readJson<ViewerResponse>("/api/auth/me");
    setCurrentUser(data.user);
    setDemoAccountId(data.demoAccountId);
    return data;
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
      await loadViewer();
      const data = await loadRooms();
      if (activeRoomId) {
        await loadRoom(activeRoomId);
      } else if (data.rooms.length > 0) {
        const fallbackRoomId = resolveDefaultRoomId(data.rooms);
        if (fallbackRoomId) {
          setActiveRoomId(fallbackRoomId);
          await loadRoom(fallbackRoomId);
        }
      }
    } catch (err) {
      if (err instanceof FetchJsonError && err.status === 401) {
        setAuthRequired(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load data");
      }
    }
  }

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        setError(null);
        await loadViewer();
        const initial = await loadRooms();

        let roomsToUse = initial.rooms;
        if (initial.demoMode && roomsToUse.length < 3) {
          try {
            await fetch("/api/seed", { method: "POST" });
            const seeded = await loadRooms();
            roomsToUse = seeded.rooms;
          } catch {
            // Demo seed is optional; API returns 403 when DEMO_BYPASS_AUTH is off.
          }
        }

        const roomId = resolveDefaultRoomId(roomsToUse);
        if (roomId) {
          setActiveRoomId(roomId);
          await loadRoom(roomId);
        }
      } catch (err) {
        if (mounted) {
          if (err instanceof FetchJsonError && err.status === 401) {
            setAuthRequired(true);
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : "Failed to load rooms");
          }
        }
      } finally {
        if (mounted) {
          setBootstrapping(false);
        }
      }
    };

    bootstrap();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (bootstrapping) {
      return;
    }

    const timer = setInterval(() => {
      refreshAll();
    }, 20000);

    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapping, activeRoomId]);

  useEffect(() => {
    if (!activeRoomId || bootstrapping) return;
    loadRoom(activeRoomId).catch((err) => setError(err instanceof Error ? err.message : "Failed to load room"));
  }, [activeRoomId, bootstrapping]);

  useEffect(() => {
    if (!activeRoomId || bootstrapping) {
      return;
    }

    const stream = new EventSource(`/api/rooms/${activeRoomId}/stream`);

    const decode = <T,>(rawEvent: Event): T | null => {
      if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== "string") {
        return null;
      }

      try {
        return JSON.parse(rawEvent.data) as T;
      } catch {
        return null;
      }
    };

    const applyPatch = (event: RoomPatchEvent) => {
      const snapshot = event.snapshot;

      if (!snapshot || !snapshot.room || !snapshot.roomSummary) {
        return;
      }

      const roomSummary: RoomSummary = snapshot.roomSummary;

      setError(null);
      setActiveRoom(snapshot.room);
      setWeighted(snapshot.weighted);
      setRecurrenceBanner(snapshot.recurrenceBanner);
      setRooms((previous) => {
        const next = [...previous];
        const index = next.findIndex((room) => room.id === roomSummary.id);

        if (index >= 0) {
          next[index] = roomSummary;
        } else {
          next.unshift(roomSummary);
        }

        return sortRoomsByPriority(next);
      });
    };

    stream.addEventListener("stream.ready", () => {
      setError(null);
    });

    stream.addEventListener("room.patch", (rawEvent) => {
      const event = decode<RoomPatchEvent>(rawEvent);

      if (!event || event.roomId !== activeRoomId) {
        return;
      }

      applyPatch(event);
    });

    stream.addEventListener("stream.error", () => {
      setError("Live stream interrupted. Reconnecting...");

      loadRoom(activeRoomId).catch(() => {
        // Periodic refresh covers persistent failures.
      });
      loadRooms().catch(() => {
        // Periodic refresh covers persistent failures.
      });
    });

    stream.onerror = () => {
      setError("Realtime connection dropped. Falling back to periodic refresh.");

      loadRoom(activeRoomId).catch(() => {
        // Periodic refresh covers persistent failures.
      });
      loadRooms().catch(() => {
        // Periodic refresh covers persistent failures.
      });
    };

    return () => {
      stream.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, bootstrapping]);

  const latestAgentEvent = useMemo(() => {
    if (!activeRoom?.agentEvents?.length) {
      return null;
    }

    return activeRoom.agentEvents[activeRoom.agentEvents.length - 1];
  }, [activeRoom]);

  async function submitClaim() {
    if (blockObserverAction()) {
      return;
    }

    if (!claimText.trim() && !claimUrl.trim() && !claimImage) return;

    try {
      setBusy(true);
      setError(null);

      let sourceType: "TEXT" | "URL" | "IMAGE" = "TEXT";
      let uploadedImageUrl: string | undefined;
      let imageMime: string | undefined;
      let imageSize: number | undefined;

      if (claimImage) {
        sourceType = "IMAGE";
        const payload = new FormData();
        payload.append("file", claimImage);

        const uploadRes = await fetch("/api/uploads/image", {
          method: "POST",
          body: payload
        });

        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) {
          throw new Error(uploadData?.detail ?? uploadData?.error ?? "Failed to upload image");
        }

        uploadedImageUrl = uploadData.url as string;
        imageMime = uploadData.mime as string;
        imageSize = uploadData.size as number;
      } else if (claimUrl.trim()) {
        sourceType = "URL";
      }

      const data = await readJson<{ room: RoomSummary }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({
          claimText: claimText.trim() || claimUrl.trim() || "Image claim submitted",
          sourceType,
          claimUrl: sourceType === "IMAGE" ? uploadedImageUrl : claimUrl.trim() || undefined,
          imageMime,
          imageSize
        })
      });

      setClaimText("");
      setClaimUrl("");
      setClaimImage(null);
      setActiveRoomId(data.room.id);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit claim");
    } finally {
      setBusy(false);
    }
  }

  async function submitEvidence() {
    if (blockObserverAction()) {
      return;
    }

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

  async function submitRoomMessage() {
    if (blockObserverAction()) {
      return;
    }

    if (!activeRoomId || !chatDraft.trim()) {
      return;
    }

    try {
      setBusy(true);
      setError(null);
      const payload: { body: string; kind: "CHAT" | "PROOF_NOTE"; evidenceId?: string } = {
        body: chatDraft.trim(),
        kind: proofThreadEvidenceId ? "PROOF_NOTE" : "CHAT"
      };

      if (proofThreadEvidenceId) {
        payload.evidenceId = proofThreadEvidenceId;
      }

      await readJson(`/api/rooms/${activeRoomId}/messages`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setChatDraft("");
      setProofThreadEvidenceId("");
      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setBusy(false);
    }
  }

  async function castVote() {
    if (blockObserverAction()) {
      return;
    }

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
    if (blockObserverAction()) {
      return;
    }

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
    if (blockObserverAction()) {
      return;
    }

    if (!activeRoomId) return;

    try {
      setBusy(true);
      setError(null);
      const result = await readJson<{ ok: boolean; pending?: boolean; message?: string }>(
        `/api/rooms/${activeRoomId}/clarity-card`,
        {
          method: "POST"
        }
      );

      if (result.pending) {
        setInlineMessage(result.message ?? "Clarity card generation is running in background.");
      }

      await loadRoom(activeRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate clarity card");
    } finally {
      setBusy(false);
    }
  }

  async function disputeAgentEvidence(evidenceId: string) {
    if (blockObserverAction()) {
      return;
    }

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

  const observerNotice = inlineMessage ?? (observerReadOnly ? "This session is in read-only mode." : null);
  const viewerIdentity = currentUser?.name ?? currentUser?.email ?? "Session user";
  const viewerMeta = [currentUser?.role, demoMode && demoAccountId ? `demo:${demoAccountId}` : null]
    .filter(Boolean)
    .join(" • ");

  if (!bootstrapping && authRequired) {
    return (
      <main className="veriwire-shell min-h-screen p-6 md:p-10">
        <div className="mx-auto max-w-md border border-white/10 bg-vv-surface1/90 p-6 text-vv-text">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-vv-accent">VeriWire</p>
          <h1 className="mt-3 text-xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-vv-muted">
            The API rejected this session. Use GitHub or email sign-in, or enable demo bypass for local development.
          </p>
          <a
            href="/login"
            className="mt-6 inline-block border border-vv-accent/60 bg-vv-accent/10 px-4 py-2 text-sm font-semibold text-vv-accent hover:bg-vv-accent/20"
          >
            Go to sign in
          </a>
        </div>
      </main>
    );
  }

  if (bootstrapping) {
    return (
      <main className="veriwire-shell min-h-screen p-3 md:p-5">
        <div className="veriwire-topbar mx-auto mb-4 flex max-w-[1460px] items-center justify-between px-4 py-3 animate-rise md:px-5">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-vv-accent">VeriWire</p>
            <p className="text-sm text-vv-muted">Collaborative misinformation resolution rooms</p>
          </div>
          <div className="hidden text-right font-mono text-xs text-vv-muted md:block">
            {currentUser ? (
              <>
                <p className="text-vv-text">{viewerIdentity}</p>
                <p>{viewerMeta}</p>
                <a
                  href={demoMode ? "/api/auth/demo-logout?next=/login" : "/login"}
                  className="mt-1 inline-block underline underline-offset-2 hover:text-vv-text"
                >
                  {demoMode ? "Switch account" : "Manage session"}
                </a>
              </>
            ) : demoMode ? (
              <>
                <p>DEMO MODE ENABLED</p>
                <p>{observerReadOnly ? "Read-only demo session active" : "Full-access demo session active"}</p>
              </>
            ) : (
              <>
                <p>LIVE MODE</p>
                <p>Authenticated workflow active</p>
              </>
            )}
          </div>
        </div>

        {demoMode && observerReadOnly && showDemoBanner ? (
          <div className="veriwire-alert mx-auto mb-3 flex max-w-[1460px] items-center justify-between border border-vv-amber/50 bg-vv-amber/10 px-4 py-2 text-sm text-vv-amber">
            <p>This demo session is read-only and cannot submit evidence, vote, or close rooms.</p>
            <button
              onClick={() => setShowDemoBanner(false)}
              className="border border-vv-amber/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] hover:bg-vv-amber/15"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <DemoLayoutSkeleton />
      </main>
    );
  }

  return (
    <main className="veriwire-shell min-h-screen p-3 md:p-5">
      <div className="veriwire-topbar mx-auto mb-4 flex max-w-[1460px] items-center justify-between px-4 py-3 animate-rise md:px-5">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-vv-accent">VeriWire</p>
          <p className="text-sm text-vv-muted">Reddit pulse + Twitter velocity + GitHub issue workflow</p>
        </div>
        <div className="hidden text-right font-mono text-xs text-vv-muted md:block">
          {currentUser ? (
            <>
              <p className="text-vv-text">{viewerIdentity}</p>
              <p>{viewerMeta}</p>
              <a
                href={demoMode ? "/api/auth/demo-logout?next=/login" : "/login"}
                className="mt-1 inline-block underline underline-offset-2 hover:text-vv-text"
              >
                {demoMode ? "Switch account" : "Manage session"}
              </a>
            </>
          ) : demoMode ? (
            <>
              <p>DEMO MODE ENABLED</p>
              <p>{observerReadOnly ? "Read-only demo session active" : "Full-access demo session active"}</p>
            </>
          ) : (
            <>
              <p>LIVE MODE</p>
              <p>Authenticated workflow active</p>
            </>
          )}
        </div>
      </div>

      {demoMode && observerReadOnly && showDemoBanner ? (
        <div className="veriwire-alert mx-auto mb-3 flex max-w-[1460px] items-center justify-between border border-vv-amber/50 bg-vv-amber/10 px-4 py-2 text-sm text-vv-amber">
          <p>This demo session is read-only and cannot submit evidence, vote, or close rooms.</p>
          <button
            onClick={() => setShowDemoBanner(false)}
            className="border border-vv-amber/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] hover:bg-vv-amber/15"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {observerNotice ? (
        <p className="mx-auto mb-3 max-w-[1460px] rounded-lg border border-vv-amber/40 bg-vv-amber/10 px-3 py-2 text-sm text-vv-amber">
          {observerNotice}
        </p>
      ) : null}

      <div className="card-shell mx-auto mb-4 max-w-[1460px] p-3 md:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Create New Rumour Room</p>
            <p className="text-xs text-vv-muted">Post like social media, resolve like an issue tracker.</p>
          </div>
          <button
            onClick={submitClaim}
            disabled={busy || observerReadOnly || (!claimText.trim() && !claimUrl.trim() && !claimImage)}
            className="rounded-lg border border-vv-accent/70 bg-vv-accent/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent shadow-[0_10px_22px_rgba(255,107,53,0.25)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Room"}
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_210px]">
          <input
            value={claimText}
            onChange={(event) => setClaimText(event.target.value)}
            maxLength={1000}
            className="w-full border border-vv-border bg-vv-surface2 px-3 py-2 text-sm text-vv-text outline-none focus:border-vv-accent"
            placeholder="What is the rumour or claim?"
            disabled={busy || observerReadOnly}
          />
          <input
            value={claimUrl}
            onChange={(event) => setClaimUrl(event.target.value)}
            className="w-full border border-vv-border bg-vv-surface2 px-3 py-2 text-sm text-vv-text outline-none focus:border-vv-accent"
            placeholder="Optional source URL"
            disabled={busy || observerReadOnly}
          />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => setClaimImage(event.target.files?.[0] ?? null)}
            className="w-full border border-vv-border bg-vv-surface2 px-3 py-2 text-xs text-vv-muted outline-none file:mr-2 file:rounded-md file:border-0 file:bg-vv-accent/20 file:px-2 file:py-1 file:text-vv-accent"
            disabled={busy || observerReadOnly}
          />
        </div>
      </div>

      <div className="mx-auto grid max-w-[1460px] grid-cols-1 gap-4 md:grid-cols-[300px_1fr_360px] animate-rise">
        <aside className={cn("card-shell hidden overflow-hidden p-2 md:block")}> 
          <div className="rounded-lg border border-white/10 bg-vv-surface2/70 px-3 py-3">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-vv-muted">Community Feed</p>
            <p className="mt-1 text-xs text-vv-muted/80">{rooms.length} active case files • tap to enter thread</p>
          </div>
          <div className="mt-2 max-h-[calc(100vh-222px)] overflow-y-auto pr-1">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                className={cn(
                  "group mb-2 w-full rounded-lg border border-white/10 bg-vv-surface2/70 px-3 py-3 text-left transition hover:border-vv-accent/35 hover:bg-vv-surface3/70",
                  activeRoomId === room.id && "feed-item-active border-vv-accent/45 bg-vv-surface3/80"
                )}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] tracking-[0.12em] text-vv-muted">{room.id}</span>
                  <span className={cn("status-pill", statusClassMap[room.status])}>{room.status}</span>
                </div>
                <p className="line-clamp-2 text-xs text-vv-text group-hover:text-vv-accent">{room.claimRaw}</p>
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
              <div className={cn("border-l-4 bg-vv-surface2/95 px-4 py-4 md:px-5 md:py-5", statusTint(activeRoom))}>
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-mono text-xs uppercase tracking-[0.24em] text-vv-amber">Claim Docket</p>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border border-white/15 bg-vv-surface3/80 px-2 py-1 font-mono text-xs text-vv-muted">
                      {activeRoom.id}
                    </span>
                    <span className={cn("status-pill", statusClassMap[activeRoom.status])}>{activeRoom.status}</span>
                  </div>
                </div>
                <p className="font-mono text-lg font-semibold leading-tight text-vv-text md:text-xl">{activeRoom.claimRaw}</p>
                <p className="mt-2 text-xs text-vv-muted">Issue thread root • immutable claim record</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="status-pill border-vv-accent/45 text-vv-accent">
                    Heat {Math.round(activeRoom.heatScore * 100)}%
                  </span>
                  <span className="status-pill border-vv-slate/40 text-vv-muted">
                    Resurfaced {activeRoom.recurrenceCount}x
                  </span>
                  {activeRoom.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="status-pill border-white/20 text-vv-muted">
                      #{tag}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => setStatus("INVESTIGATING")}
                    disabled={busy || observerReadOnly || activeRoom.status !== "OPEN"}
                    className="rounded-md border border-vv-amber/50 bg-vv-amber/10 px-3 py-1.5 text-xs text-vv-amber disabled:opacity-40"
                  >
                    Set Investigating
                  </button>
                  <button
                    onClick={() => setStatus("PENDING_VERDICT")}
                    disabled={busy || observerReadOnly || activeRoom.status !== "INVESTIGATING"}
                    className="rounded-md border border-vv-accent/50 bg-vv-accent/10 px-3 py-1.5 text-xs text-vv-accent disabled:opacity-40"
                  >
                    Open Poll
                  </button>
                  <button
                    onClick={() => setStatus("CLOSED")}
                    disabled={busy || observerReadOnly || activeRoom.status !== "PENDING_VERDICT"}
                    className="rounded-md border border-vv-emerald/50 bg-vv-emerald/10 px-3 py-1.5 text-xs text-vv-emerald disabled:opacity-40"
                  >
                    Close Room
                  </button>
                </div>
              </div>

              {recurrenceBanner ? (
                <div className="border-y border-vv-amber/45 bg-vv-amber/10 px-4 py-2 text-xs text-vv-amber md:px-5">
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
                <div className="border-b border-white/10 bg-vv-surface3/70 px-4 py-2 text-sm text-vv-muted md:px-5">
                  This room is closed. Verdict: {activeRoom.verdict ?? "UNCLEAR"}.
                </div>
              ) : null}

              <div className="border-t border-white/10 bg-vv-surface1/90 p-3 md:px-4 md:py-4">
                <p className="mb-2 font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Add Evidence</p>
                <div className="grid gap-2 md:grid-cols-[1fr_160px_120px]">
                  <input
                    value={evidenceUrl}
                    onChange={(event) => setEvidenceUrl(event.target.value)}
                    className="w-full border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
                    placeholder="https://source.url"
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
                  />
                  <select
                    value={evidenceStance}
                    onChange={(event) => setEvidenceStance(event.target.value as "SUPPORTS" | "REFUTES" | "CONTEXT")}
                    className="border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
                  >
                    <option value="SUPPORTS">SUPPORTS</option>
                    <option value="REFUTES">REFUTES</option>
                    <option value="CONTEXT">CONTEXT</option>
                  </select>
                  <button
                    onClick={submitEvidence}
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
                    className="border border-vv-accent/70 bg-vv-accent/15 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent shadow-[0_8px_18px_rgba(255,107,53,0.22)] transition hover:bg-vv-accent/25 disabled:opacity-40"
                  >
                    Add Source
                  </button>
                </div>
              </div>

              <div className="max-h-[42vh] space-y-3 overflow-y-auto bg-vv-surface1/30 px-3 py-3 md:px-4">
                {activeRoom.evidence.map((item) => {
                  const isAgent = item.submittedBy === "AGENT";
                  const disputed = item.disputedBy.length >= 2;

                  return (
                    <article
                      key={item.id}
                      className={cn(
                        "rounded-lg border border-white/10 bg-vv-surface2/95 p-3 shadow-[0_12px_22px_rgba(0,0,0,0.25)]",
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
                            disabled={busy || observerReadOnly}
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

              <div className="border-t border-white/10 bg-vv-surface3/40 px-3 py-3 md:px-4">
                <p className="mb-2 font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Discussion Thread (Live)</p>
                <p className="mb-2 text-[11px] text-vv-muted">
                  Discuss the claim and tie notes to a proof. Mention <span className="font-mono">@agent</span> or start with
                  <span className="font-mono"> /agent</span> to ask for the agent&apos;s opinion and proof-backed response in this
                  thread. Include words like <span className="font-mono">show proofs</span> or <span className="font-mono">cite sources</span> to
                  get linked proof notes. Updates sync over the room stream and publish through SpacetimeDB as the
                  primary realtime event layer.
                </p>
                <div className="mb-2 max-h-36 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-vv-surface2/80 p-2">
                  {(activeRoom.messages ?? []).length === 0 ? (
                    <p className="text-xs text-vv-muted">No messages yet.</p>
                  ) : (
                    (activeRoom.messages ?? []).map((msg) => (
                      <div key={msg.id} className="rounded-md border border-white/10 bg-vv-surface3/50 p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-vv-muted">
                          <span className="font-mono">{msg.user.name ?? msg.user.id.slice(0, 8)}</span>
                          <span>{formatAgo(msg.createdAt)}</span>
                          {msg.kind === "PROOF_NOTE" ? (
                            <span className="status-pill border-vv-accent/50 text-vv-accent">proof thread</span>
                          ) : null}
                        </div>
                        {msg.evidence ? (
                          <a
                            href={msg.evidence.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block truncate text-[11px] text-vv-accent hover:underline"
                          >
                            Re: {msg.evidence.sourceName}
                          </a>
                        ) : null}
                        <p className="mt-1 whitespace-pre-wrap text-sm text-vv-text">{msg.body}</p>
                      </div>
                    ))
                  )}
                </div>
                <div className="grid gap-2 md:grid-cols-[1fr_140px_auto]">
                  <textarea
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    maxLength={2000}
                    rows={2}
                    className="w-full resize-none border border-white/10 bg-vv-surface2 px-3 py-2 text-sm outline-none focus:border-vv-accent"
                    placeholder="Discuss the rumour or react to proofs…"
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
                  />
                  <select
                    value={proofThreadEvidenceId}
                    onChange={(event) => setProofThreadEvidenceId(event.target.value)}
                    className="border border-white/10 bg-vv-surface2 px-2 py-2 text-[11px] outline-none focus:border-vv-accent"
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
                  >
                    <option value="">Chat (no proof link)</option>
                    {activeRoom.evidence.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        Proof: {ev.sourceName.slice(0, 28)}
                        {ev.sourceName.length > 28 ? "…" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void submitRoomMessage()}
                    disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly || !chatDraft.trim()}
                    className="border border-vv-accent/70 bg-vv-accent/15 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-vv-accent shadow-[0_8px_18px_rgba(255,107,53,0.22)] disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-[70vh] items-center justify-center text-vv-muted">No active room selected</div>
          )}
        </section>

        <aside className="card-shell hidden flex-col overflow-hidden md:flex">
          <div className="border-b border-white/10 bg-vv-surface2/75 p-3">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-vv-muted">Issue Insights</p>
          </div>

          <div className="space-y-3 p-3">
            <section className="rounded-lg border border-white/10 bg-vv-surface2/95 p-3 shadow-[0_14px_24px_rgba(0,0,0,0.25)]">
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

            <section className="rounded-lg border border-white/10 bg-vv-surface2/95 p-3 shadow-[0_14px_24px_rgba(0,0,0,0.25)]">
              <p className="mb-3 text-xs uppercase tracking-[0.16em] text-vv-muted">Weighted Poll</p>
              <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
                {(["TRUE", "FALSE", "UNCLEAR"] as const).map((verdict) => (
                  <div key={verdict} className="rounded-md border border-white/10 bg-vv-surface3 px-2 py-2">
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
                  disabled={activeRoom?.status !== "PENDING_VERDICT" || busy || observerReadOnly}
                >
                  <option value="TRUE">TRUE</option>
                  <option value="FALSE">FALSE</option>
                  <option value="UNCLEAR">UNCLEAR</option>
                </select>
                <button
                  onClick={castVote}
                  disabled={activeRoom?.status !== "PENDING_VERDICT" || busy || observerReadOnly}
                  className="border border-vv-accent/70 bg-vv-accent/15 px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-vv-accent shadow-[0_8px_18px_rgba(255,107,53,0.2)] disabled:opacity-40"
                >
                  Vote
                </button>
              </div>
            </section>

            <section className="rounded-lg border border-white/10 bg-vv-surface2/95 p-3 shadow-[0_14px_24px_rgba(0,0,0,0.25)]">
              <button
                onClick={generateCard}
                disabled={!activeRoom || activeRoom.status !== "CLOSED" || busy || observerReadOnly}
                className="w-full border border-vv-accent/80 bg-vv-accent/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-vv-accent shadow-[0_0_18px_rgba(255,107,53,0.28)] disabled:opacity-40"
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

      <div className="card-shell mx-auto mt-3 max-w-[1460px] p-3 md:hidden">
        <div className="mb-2 grid grid-cols-5 gap-1">
          {(["FEED", "ROOM", "CHAT", "AGENT", "CARD"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={cn(
                "rounded-md border px-2 py-2 text-[11px] font-mono uppercase tracking-[0.12em]",
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
                className="w-full rounded-md border border-white/10 bg-vv-surface2/80 px-3 py-2 text-left"
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

        {mobileTab === "CHAT" && activeRoom ? (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto text-sm">
            {(activeRoom.messages ?? []).map((msg) => (
              <div key={msg.id} className="rounded-md border border-white/10 bg-vv-surface2/75 p-2 text-xs">
                <p className="font-mono text-[10px] text-vv-muted">
                  {msg.user.name ?? msg.user.id.slice(0, 8)} · {formatAgo(msg.createdAt)}
                  {msg.kind === "PROOF_NOTE" ? " · proof" : ""}
                </p>
                <p className="mt-1 text-vv-text">{msg.body}</p>
              </div>
            ))}
            <select
              value={proofThreadEvidenceId}
              onChange={(event) => setProofThreadEvidenceId(event.target.value)}
              className="w-full border border-white/10 bg-vv-surface2 p-2 text-[11px]"
              disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
            >
              <option value="">Chat (no proof link)</option>
              {activeRoom.evidence.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  Proof: {ev.sourceName.slice(0, 24)}
                </option>
              ))}
            </select>
            <textarea
              value={chatDraft}
              onChange={(event) => setChatDraft(event.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full border border-white/10 bg-vv-surface2 p-2 text-sm"
              placeholder="Message… (try: @agent what's your opinion? show proofs)"
              disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly}
            />
            <button
              type="button"
              onClick={() => void submitRoomMessage()}
              disabled={activeRoom.status === "CLOSED" || busy || observerReadOnly || !chatDraft.trim()}
              className="w-full border border-vv-accent/70 bg-vv-accent/10 py-2 text-xs font-semibold text-vv-accent"
            >
              Send
            </button>
          </div>
        ) : null}

        {mobileTab === "AGENT" ? (
          <div className="text-sm text-vv-muted">{latestAgentEvent?.detail ?? "No agent update yet"}</div>
        ) : null}

        {mobileTab === "CARD" ? (
          <div className="text-sm text-vv-muted">{activeRoom?.clarityCard?.rebuttalText ?? "Clarity card not generated yet."}</div>
        ) : null}
      </div>

      {error ? <p className="mx-auto mt-3 max-w-[1460px] text-sm text-vv-crimson">{error}</p> : null}
    </main>
  );
}
