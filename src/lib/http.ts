import { NextResponse } from "next/server";
import { ApiError } from "@/types/domain";

export class ApiHttpError extends Error {
  status: number;
  detail?: string;
  rule?: string;

  constructor(status: number, error: string, detail?: string, rule?: string) {
    super(error);
    this.name = "ApiHttpError";
    this.status = status;
    this.detail = detail;
    this.rule = rule;
  }
}

export function jsonError(status: number, payload: ApiError) {
  return NextResponse.json(payload, { status });
}

export function handleRouteError(error: unknown) {
  if (error instanceof ApiHttpError) {
    return jsonError(error.status, {
      error: error.message,
      detail: error.detail,
      rule: error.rule
    });
  }

  if (error instanceof Error) {
    return jsonError(500, {
      error: "Internal server error",
      detail: error.message
    });
  }

  return jsonError(500, {
    error: "Internal server error"
  });
}
