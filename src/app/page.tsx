import { VeriWireApp } from "@/components/veriwire-app";

export default function Home({
  searchParams
}: {
  searchParams: {
    room?: string;
  };
}) {
  return <VeriWireApp initialRoomId={searchParams.room ?? null} />;
}

