import {
  PrismaClient,
  RoomRole,
  RoomStatus,
  Verdict,
  Confidence,
  Stance,
  EvidenceType,
  GlobalRole,
  ChecklistStatus
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const observer = await prisma.user.upsert({
    where: { email: "observer@veriwire.demo" },
    update: {},
    create: {
      email: "observer@veriwire.demo",
      name: "Demo Observer",
      role: GlobalRole.USER,
      contributorScore: 1.0
    }
  });

  const moderator = await prisma.user.upsert({
    where: { email: "moderator@veriwire.demo" },
    update: {},
    create: {
      email: "moderator@veriwire.demo",
      name: "Fact Moderator",
      role: GlobalRole.MODERATOR,
      contributorScore: 2.4
    }
  });

  await prisma.room.deleteMany({ where: { id: { in: ["VWRM0001", "VWRM0002", "VWRM0003"] } } });

  const room1 = await prisma.room.create({
    data: {
      id: "VWRM0001",
      claimRaw: "Drinking hot water with turmeric cures dengue fever",
      claimNormalized: "Hot water with turmeric cures dengue fever",
      status: RoomStatus.INVESTIGATING,
      tags: ["health", "viral-remedy"],
      createdBy: moderator.id,
      heatScore: 0.82,
      recurrenceCount: 1
    }
  });

  const room2 = await prisma.room.create({
    data: {
      id: "VWRM0002",
      claimRaw: "Government announced free LPG cylinders for BPL families",
      claimNormalized: "Government announced free LPG cylinders for BPL families",
      status: RoomStatus.PENDING_VERDICT,
      tags: ["policy", "benefits"],
      createdBy: moderator.id,
      heatScore: 0.74,
      recurrenceCount: 3
    }
  });

  const room3 = await prisma.room.create({
    data: {
      id: "VWRM0003",
      claimRaw: "New WhatsApp update lets anyone see your deleted messages",
      claimNormalized: "A WhatsApp update lets others read deleted messages",
      status: RoomStatus.CLOSED,
      verdict: Verdict.FALSE,
      confidence: Confidence.HIGH,
      tags: ["tech", "whatsapp"],
      createdBy: moderator.id,
      heatScore: 0.61,
      recurrenceCount: 5,
      closedAt: new Date()
    }
  });

  await prisma.roomMember.createMany({
    data: [
      { roomId: room1.id, userId: moderator.id, role: RoomRole.OWNER },
      { roomId: room1.id, userId: observer.id, role: RoomRole.CONTRIBUTOR },
      { roomId: room2.id, userId: moderator.id, role: RoomRole.OWNER },
      { roomId: room2.id, userId: observer.id, role: RoomRole.VOTER },
      { roomId: room3.id, userId: moderator.id, role: RoomRole.OWNER },
      { roomId: room3.id, userId: observer.id, role: RoomRole.OBSERVER }
    ]
  });

  await prisma.evidence.createMany({
    data: [
      {
        roomId: room1.id,
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
        roomId: room1.id,
        submittedBy: observer.id,
        sourceUrl: "https://www.cdc.gov/dengue/about/index.html",
        sourceName: "CDC",
        snippet: "CDC guidance focuses on hydration, rest, and medical supervision rather than home cure claims.",
        stance: Stance.REFUTES,
        type: EvidenceType.OBSERVATION,
        agentConfidence: null,
        disputedBy: []
      },
      {
        roomId: room1.id,
        submittedBy: "AGENT",
        sourceUrl: "https://www.researchgate.net/publication/example",
        sourceName: "Research summary",
        snippet: "Turmeric compounds are discussed in lab settings, but no direct dengue cure evidence in humans.",
        stance: Stance.CONTEXT,
        type: EvidenceType.INFERENCE,
        agentConfidence: 0.56,
        disputedBy: []
      }
    ]
  });

  await prisma.vote.createMany({
    data: [
      { roomId: room2.id, userId: observer.id, verdict: Verdict.FALSE, weight: 1.2 },
      { roomId: room2.id, userId: moderator.id, verdict: Verdict.FALSE, weight: 2.4 }
    ]
  });

  await prisma.agentEvent.createMany({
    data: [
      { roomId: room1.id, step: "QUERY_GENERATION", detail: "Generated 4 search queries", progress: 20 },
      { roomId: room1.id, step: "SOURCE_FETCH", detail: "Fetched 4/4 sources", progress: 65 },
      { roomId: room1.id, step: "SUMMARY", detail: "Observation/Inference/Speculation summary ready", progress: 100 },
      { roomId: room2.id, step: "COMPLETE", detail: "Agent run complete. Poll unlocked.", progress: 100 }
    ]
  });

  await prisma.checklistTask.createMany({
    data: [
      { roomId: room1.id, title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room1.id, title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room1.id, title: "Poll opened", status: ChecklistStatus.PENDING },
      { roomId: room1.id, title: "Verdict reached", status: ChecklistStatus.PENDING },
      { roomId: room2.id, title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room2.id, title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room2.id, title: "Poll opened", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room2.id, title: "Verdict reached", status: ChecklistStatus.PENDING },
      { roomId: room3.id, title: "Agent run complete", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room3.id, title: "3 evidence items added", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room3.id, title: "Poll opened", status: ChecklistStatus.DONE, completedAt: new Date() },
      { roomId: room3.id, title: "Verdict reached", status: ChecklistStatus.DONE, completedAt: new Date() }
    ]
  });

  await prisma.clarityCard.create({
    data: {
      roomId: room3.id,
      claimShort: "WhatsApp update allows everyone to read deleted messages",
      verdict: "FALSE",
      confidence: "HIGH",
      evidenceBullets: [
        "Official WhatsApp documentation confirms deleted messages are not universally recoverable.",
        "Security researchers found no feature that exposes all deleted messages to all users."
      ],
      rebuttalText: "This forward is false. WhatsApp has not released an update that lets anyone view deleted messages across chats.",
      imageUrl: "/mock/clarity-card-vwrm0003.png",
      audioUrl: "/mock/clarity-card-vwrm0003.mp3",
      qrUrl: "https://veriwire.demo/rooms/VWRM0003"
    }
  });

  await prisma.publishedQueue.create({
    data: {
      roomId: room3.id
    }
  });

  await prisma.recurrenceRecord.upsert({
    where: { claimFingerprint: "government-announced-free-lpg-cylinders-for-bpl-families" },
    update: {
      roomIds: [room2.id],
      lastSeen: new Date(),
      recurrenceCount: 3
    },
    create: {
      claimFingerprint: "government-announced-free-lpg-cylinders-for-bpl-families",
      roomIds: [room2.id],
      firstSeen: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8),
      lastSeen: new Date(),
      recurrenceCount: 3
    }
  });

  await prisma.auditLog.createMany({
    data: [
      {
        roomId: room1.id,
        actorId: moderator.id,
        actorType: "USER",
        action: "ROOM_CREATED",
        payload: { status: room1.status }
      },
      {
        roomId: room2.id,
        actorId: moderator.id,
        actorType: "USER",
        action: "STATUS_SET_PENDING_VERDICT",
        payload: { status: room2.status }
      },
      {
        roomId: room3.id,
        actorId: moderator.id,
        actorType: "USER",
        action: "ROOM_CLOSED",
        payload: { verdict: room3.verdict, confidence: room3.confidence }
      }
    ]
  });

  console.log("Seed complete");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
