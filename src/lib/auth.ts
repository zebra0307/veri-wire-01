import { GlobalRole } from "@prisma/client";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { nanoid } from "nanoid";
import { getServerSession, type NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GitHubProvider from "next-auth/providers/github";
import { env } from "@/lib/env";
import { ApiHttpError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { SessionUser } from "@/types/domain";

const providers = [];

if (env.GITHUB_ID && env.GITHUB_SECRET) {
  providers.push(
    GitHubProvider({
      clientId: env.GITHUB_ID,
      clientSecret: env.GITHUB_SECRET,
      allowDangerousEmailAccountLinking: true
    })
  );
}

if (
  env.EMAIL_SERVER_HOST &&
  env.EMAIL_SERVER_PORT &&
  env.EMAIL_SERVER_USER &&
  env.EMAIL_SERVER_PASSWORD &&
  env.EMAIL_FROM
) {
  providers.push(
    EmailProvider({
      server: {
        host: env.EMAIL_SERVER_HOST,
        port: Number(env.EMAIL_SERVER_PORT),
        auth: {
          user: env.EMAIL_SERVER_USER,
          pass: env.EMAIL_SERVER_PASSWORD
        }
      },
      from: env.EMAIL_FROM
    })
  );
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers,
  pages: {
    signIn: "/"
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24,
    updateAge: 60 * 5
  },
  callbacks: {
    async jwt({ token, user }) {
      const now = Math.floor(Date.now() / 1000);

      if (user) {
        token.uid = user.id;
        token.role = ((user as { role?: GlobalRole }).role ?? GlobalRole.USER) as "USER" | "MODERATOR" | "ADMIN";
        token.refreshToken = nanoid(24);
        token.refreshRotatedAt = now;
      }

      if (!token.refreshToken || now - (token.refreshRotatedAt ?? 0) > 60) {
        token.refreshToken = nanoid(24);
        token.refreshRotatedAt = now;
      }

      return token;
    },
    async session({ session, token }) {
      if (!session.user) {
        return session;
      }

      session.user.id = token.uid;
      session.user.role = token.role;
      session.user.refreshToken = token.refreshToken;
      return session;
    }
  },
  secret: env.NEXTAUTH_SECRET
};

export async function getSessionUser(): Promise<SessionUser> {
  const session = await getServerSession(authOptions);

  if (session?.user?.id) {
    return {
      id: session.user.id,
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      role: session.user.role
    };
  }

  if (env.DEMO_BYPASS_AUTH) {
    const observer = await prisma.user.findUnique({
      where: {
        email: "observer@veriwire.demo"
      }
    });

    if (observer) {
      return {
        id: observer.id,
        name: observer.name ?? null,
        email: observer.email ?? null,
        role: observer.role
      };
    }
  }

  throw new ApiHttpError(401, "Unauthorized");
}
