import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: "USER" | "MODERATOR" | "ADMIN";
      refreshToken: string;
    };
  }

  interface User {
    role: "USER" | "MODERATOR" | "ADMIN";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid: string;
    role: "USER" | "MODERATOR" | "ADMIN";
    refreshToken: string;
    refreshRotatedAt: number;
  }
}
