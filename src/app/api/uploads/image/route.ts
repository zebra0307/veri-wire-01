import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";

const allowedImageMime = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser();
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return jsonError(400, { error: "Missing image file" });
    }

    if (!allowedImageMime.has(file.type)) {
      return jsonError(400, { error: "Unsupported image MIME type. SVG is blocked." });
    }

    if (file.size > 5 * 1024 * 1024) {
      return jsonError(400, { error: "Image exceeds 5MB limit" });
    }

    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const filename = `${nanoid(12)}.${extension}`;

    const uploadDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadDir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(uploadDir, filename), buffer);

    const url = `/uploads/${filename}`;

    await appendAuditLog({
      actorId: user.id,
      actorType: "USER",
      action: "IMAGE_UPLOADED",
      payload: {
        mime: file.type,
        size: file.size,
        url
      }
    });

    return NextResponse.json({
      ok: true,
      url,
      mime: file.type,
      size: file.size
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
