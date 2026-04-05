import {
  ChecklistStatus,
  Confidence,
  EvidenceType,
  RoomRole,
  RoomStatus,
  Stance,
  Verdict
} from "@prisma/client";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { demoAccounts } from "@/lib/demo-auth";
import { env } from "@/lib/env";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

const DEMO_ROOM_IDS = ["VWRM0001", "VWRM0002", "VWRM0003"] as const;

export async function POST() {
  try {
    if (!env.DEMO_BYPASS_AUTH) {
      return jsonError(403, { error: "Demo seeding is disabled" });
    }

    await getSessionUser();

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 8);

      const demoUsers: Record<string, { id: string }> = {};
      for (const account of demoAccounts) {
        const user = await tx.user.upsert({
          where: { email: account.email },
          update: {
            name: account.name,
            role: account.role,
            contributorScore: account.contributorScore
          },
          create: {
            email: account.email,
            name: account.name,
            role: account.role,
            contributorScore: account.contributorScore
          }
        });

        demoUsers[account.id] = { id: user.id };
      }

      const dummy1 = demoUsers.dummy1;
      const dummy2 = demoUsers.dummy2;
      const dummy3 = demoUsers.dummy3;
      const dummy4 = demoUsers.dummy4;

      if (!dummy1 || !dummy2 || !dummy3 || !dummy4) {
        throw new Error("Demo users failed to initialize");
      }

      await tx.room.upsert({
        where: { id: "VWRM0001" },
        update: {
          claimRaw: "Drinking hot water with turmeric cures dengue fever",
          claimNormalized: "Hot water with turmeric cures dengue fever",
          status: RoomStatus.INVESTIGATING,
          verdict: null,
          confidence: null,
          tags: ["health", "viral-remedy"],
          createdBy: dummy3.id,
          heatScore: 0.82,
          recurrenceCount: 1,
          closedAt: null,
          clarityCardUrl: null,
          voiceBriefUrl: null,
          piiFlagged: false
        },
        create: {
          id: "VWRM0001",
          claimRaw: "Drinking hot water with turmeric cures dengue fever",
          claimNormalized: "Hot water with turmeric cures dengue fever",
          status: RoomStatus.INVESTIGATING,
          tags: ["health", "viral-remedy"],
          createdBy: dummy3.id,
          heatScore: 0.82,
          recurrenceCount: 1,
          piiFlagged: false
        }
      });

      await tx.room.upsert({
        where: { id: "VWRM0002" },
        update: {
          claimRaw: "Government announced free LPG cylinders for BPL families",
          claimNormalized: "Government announced free LPG cylinders for BPL families",
          status: RoomStatus.PENDING_VERDICT,
          verdict: null,
          confidence: null,
          tags: ["policy", "benefits"],
          createdBy: dummy3.id,
          heatScore: 0.74,
          recurrenceCount: 3,
          closedAt: null,
          clarityCardUrl: null,
          voiceBriefUrl: null,
          piiFlagged: false
        },
        create: {
          id: "VWRM0002",
          claimRaw: "Government announced free LPG cylinders for BPL families",
          claimNormalized: "Government announced free LPG cylinders for BPL families",
          status: RoomStatus.PENDING_VERDICT,
          tags: ["policy", "benefits"],
          createdBy: dummy3.id,
          heatScore: 0.74,
          recurrenceCount: 3,
          piiFlagged: false
        }
      });

      await tx.room.upsert({
        where: { id: "VWRM0003" },
        update: {
          claimRaw: "New WhatsApp update lets anyone see your deleted messages",
          claimNormalized: "A WhatsApp update lets others read deleted messages",
          status: RoomStatus.CLOSED,
          verdict: Verdict.FALSE,
          confidence: Confidence.HIGH,
          tags: ["tech", "whatsapp"],
          createdBy: dummy3.id,
          heatScore: 0.61,
          recurrenceCount: 5,
          closedAt: now,
          clarityCardUrl: "/cards/VWRM0003.png",
          voiceBriefUrl: "/cards/VWRM0003.mp3",
          piiFlagged: false
        },
        create: {
          id: "VWRM0003",
          claimRaw: "New WhatsApp update lets anyone see your deleted messages",
          claimNormalized: "A WhatsApp update lets others read deleted messages",
          status: RoomStatus.CLOSED,
          verdict: Verdict.FALSE,
          confidence: Confidence.HIGH,
          tags: ["tech", "whatsapp"],
          createdBy: dummy3.id,
          heatScore: 0.61,
          recurrenceCount: 5,
          closedAt: now,
          clarityCardUrl: "/cards/VWRM0003.png",
          voiceBriefUrl: "/cards/VWRM0003.mp3",
          piiFlagged: false
        }
      });

      await tx.roomMember.deleteMany({ where: { roomId: { in: [...DEMO_ROOM_IDS] } } });
      await tx.roomMember.createMany({
        data: [
          { roomId: "VWRM0001", userId: dummy1.id, role: RoomRole.OWNER },
          { roomId: "VWRM0001", userId: dummy2.id, role: RoomRole.OWNER },
          { roomId: "VWRM0001", userId: dummy3.id, role: RoomRole.OWNER },
          { roomId: "VWRM0001", userId: dummy4.id, role: RoomRole.OWNER },
          { roomId: "VWRM0002", userId: dummy1.id, role: RoomRole.OWNER },
          { roomId: "VWRM0002", userId: dummy2.id, role: RoomRole.OWNER },
          { roomId: "VWRM0002", userId: dummy3.id, role: RoomRole.OWNER },
          { roomId: "VWRM0002", userId: dummy4.id, role: RoomRole.OWNER },
          { roomId: "VWRM0003", userId: dummy1.id, role: RoomRole.OWNER },
          { roomId: "VWRM0003", userId: dummy2.id, role: RoomRole.OWNER },
          { roomId: "VWRM0003", userId: dummy3.id, role: RoomRole.OWNER },
          { roomId: "VWRM0003", userId: dummy4.id, role: RoomRole.OWNER }
        ],
        skipDuplicates: true
      });

      await tx.evidence.deleteMany({ where: { roomId: { in: [...DEMO_ROOM_IDS] } } });
      await tx.evidence.createMany({
        data: [
          {
            roomId: "VWRM0001",
            submittedBy: "AGENT",
            sourceUrl: "https://www.who.int/news-room/questions-and-answers/item/dengue-and-severe-dengue",
            sourceName: "WHO",
            snippet: "WHO states dengue has no instant cure and treatment relies on clinical management.",
            stance: Stance.REFUTES,
            type: EvidenceType.OBSERVATION,
            agentConfidence: 0.9,
            disputedBy: []
          },
          {
            roomId: "VWRM0001",
            submittedBy: dummy2.id,
            sourceUrl: "https://www.cdc.gov/dengue/about/index.html",
            sourceName: "CDC",
            snippet: "CDC guidance focuses on hydration, rest, and medical supervision rather than home cure claims.",
            stance: Stance.REFUTES,
            type: EvidenceType.OBSERVATION,
            agentConfidence: null,
            disputedBy: []
          },
          {
            roomId: "VWRM0001",
            submittedBy: "AGENT",
            sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/35746813/",
            sourceName: "PubMed",
            snippet: "Curcumin is discussed in laboratory settings, but there is no clinical evidence it cures dengue.",
            stance: Stance.CONTEXT,
            type: EvidenceType.INFERENCE,
            agentConfidence: 0.56,
            disputedBy: []
          }
        ]
      });

      await tx.vote.deleteMany({ where: { roomId: { in: [...DEMO_ROOM_IDS] } } });
      await tx.vote.createMany({
        data: [
          { roomId: "VWRM0002", userId: dummy2.id, verdict: Verdict.FALSE, weight: 1.15 }
        ],
        skipDuplicates: true
      });

      await tx.agentEvent.deleteMany({ where: { roomId: { in: [...DEMO_ROOM_IDS] } } });
      await tx.agentEvent.createMany({
        data: [
          { roomId: "VWRM0001", step: "QUERY_GENERATION", detail: "Generated 4 search queries", progress: 20 },
          { roomId: "VWRM0001", step: "SOURCE_FETCH", detail: "Fetched 4/4 sources", progress: 65 },
          { roomId: "VWRM0001", step: "SUMMARY", detail: "Observation/Inference/Speculation summary ready", progress: 100 },
          { roomId: "VWRM0002", step: "COMPLETE", detail: "Agent run complete. Poll unlocked.", progress: 100 }
        ]
      });

      await tx.checklistTask.deleteMany({ where: { roomId: { in: [...DEMO_ROOM_IDS] } } });
      await tx.checklistTask.createMany({
        data: [
          { roomId: "VWRM0001", title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0001", title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0001", title: "Poll opened", status: ChecklistStatus.PENDING },
          { roomId: "VWRM0001", title: "Verdict reached", status: ChecklistStatus.PENDING },
          { roomId: "VWRM0002", title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0002", title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0002", title: "Poll opened", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0002", title: "Verdict reached", status: ChecklistStatus.PENDING },
          { roomId: "VWRM0003", title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0003", title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0003", title: "Poll opened", status: ChecklistStatus.DONE, completedAt: now },
          { roomId: "VWRM0003", title: "Verdict reached", status: ChecklistStatus.DONE, completedAt: now }
        ]
      });

      await tx.clarityCard.upsert({
        where: { roomId: "VWRM0003" },
        update: {
          claimShort: "WhatsApp update allows everyone to read deleted messages",
          verdict: "FALSE",
          confidence: "HIGH",
          evidenceBullets: [
            "Official WhatsApp documentation confirms deleted messages are not universally recoverable.",
            "Security researchers found no feature that exposes all deleted messages to all users."
          ],
          rebuttalText: "This forward is false. WhatsApp has not released an update that lets anyone view deleted messages across chats.",
          imageUrl: "/cards/VWRM0003.png",
          audioUrl: "/cards/VWRM0003.mp3",
          qrUrl: `${env.APP_URL}/?room=VWRM0003`
        },
        create: {
          roomId: "VWRM0003",
          claimShort: "WhatsApp update allows everyone to read deleted messages",
          verdict: "FALSE",
          confidence: "HIGH",
          evidenceBullets: [
            "Official WhatsApp documentation confirms deleted messages are not universally recoverable.",
            "Security researchers found no feature that exposes all deleted messages to all users."
          ],
          rebuttalText: "This forward is false. WhatsApp has not released an update that lets anyone view deleted messages across chats.",
          imageUrl: "/cards/VWRM0003.png",
          audioUrl: "/cards/VWRM0003.mp3",
          qrUrl: `${env.APP_URL}/?room=VWRM0003`
        }
      });

      await tx.publishedQueue.upsert({
        where: { roomId: "VWRM0003" },
        update: {},
        create: { roomId: "VWRM0003" }
      });

      await tx.recurrenceRecord.upsert({
        where: { claimFingerprint: "government-announced-free-lpg-cylinders-for-bpl-families" },
        update: {
          roomIds: ["VWRM0002"],
          firstSeen: eightDaysAgo,
          lastSeen: now,
          recurrenceCount: 3
        },
        create: {
          claimFingerprint: "government-announced-free-lpg-cylinders-for-bpl-families",
          roomIds: ["VWRM0002"],
          firstSeen: eightDaysAgo,
          lastSeen: now,
          recurrenceCount: 3
        }
      });

      await tx.auditLog.deleteMany({
        where: {
          roomId: { in: [...DEMO_ROOM_IDS] },
          actorId: dummy3.id,
          action: { in: ["ROOM_CREATED", "STATUS_SET_PENDING_VERDICT", "ROOM_CLOSED"] }
        }
      });

      await tx.auditLog.createMany({
        data: [
          {
            roomId: "VWRM0001",
            actorId: dummy3.id,
            actorType: "USER",
            action: "ROOM_CREATED",
            payload: { status: RoomStatus.INVESTIGATING }
          },
          {
            roomId: "VWRM0002",
            actorId: dummy3.id,
            actorType: "USER",
            action: "STATUS_SET_PENDING_VERDICT",
            payload: { status: RoomStatus.PENDING_VERDICT }
          },
          {
            roomId: "VWRM0003",
            actorId: dummy3.id,
            actorType: "USER",
            action: "ROOM_CLOSED",
            payload: { verdict: Verdict.FALSE, confidence: Confidence.HIGH }
          }
        ]
      });

      const rooms = await tx.room.findMany({
        where: { id: { in: [...DEMO_ROOM_IDS] } },
        select: {
          id: true,
          status: true,
          recurrenceCount: true,
          createdAt: true
        },
        orderBy: {
          id: "asc"
        }
      });

      return {
        rooms,
        users: {
          dummy1Id: dummy1.id,
          dummy2Id: dummy2.id,
          dummy3Id: dummy3.id,
          dummy4Id: dummy4.id
        }
      };
    });

    return NextResponse.json({
      ok: true,
      seeded: true,
      roomIds: DEMO_ROOM_IDS,
      rooms: result.rooms,
      users: result.users
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
