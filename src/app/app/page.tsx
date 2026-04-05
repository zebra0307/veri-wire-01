import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ApiHttpError } from "@/lib/http";
import { VeriWireApp } from "@/components/veriwire-app";

export default async function AppPage({
  searchParams
}: {
  searchParams?: {
    room?: string;
  };
}) {
  try {
    await getSessionUser();
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 401) {
      redirect("/login");
    }

    throw error;
  }

  return <VeriWireApp initialRoomId={searchParams?.room ?? null} />;
}
