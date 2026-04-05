import { GlobalRole } from "@prisma/client";

export type DemoAccountId = "dummy1" | "dummy2" | "dummy3" | "dummy4";

export type DemoAccount = {
  id: DemoAccountId;
  name: string;
  email: string;
  role: GlobalRole;
  contributorScore: number;
  readOnly: boolean;
  summary: string;
};

export const DEMO_AUTH_COOKIE = "veriwire_demo_account";

export const demoAccounts: readonly DemoAccount[] = [
  {
    id: "dummy1",
    name: "Dummy User 1",
    email: "dummy1@veriwire.demo",
    role: GlobalRole.USER,
    contributorScore: 1.0,
    readOnly: false,
    summary: "Full-access demo account for multi-session testing."
  },
  {
    id: "dummy2",
    name: "Dummy User 2",
    email: "dummy2@veriwire.demo",
    role: GlobalRole.USER,
    contributorScore: 1.15,
    readOnly: false,
    summary: "Full-access demo account with slightly higher vote weight."
  },
  {
    id: "dummy3",
    name: "Dummy User 3",
    email: "dummy3@veriwire.demo",
    role: GlobalRole.MODERATOR,
    contributorScore: 1.4,
    readOnly: false,
    summary: "Full-access moderator-profile demo account."
  },
  {
    id: "dummy4",
    name: "Dummy User 4",
    email: "dummy4@veriwire.demo",
    role: GlobalRole.ADMIN,
    contributorScore: 1.8,
    readOnly: false,
    summary: "Full-access admin-profile demo account."
  }
];

const demoAccountById = new Map<string, DemoAccount>(demoAccounts.map((account) => [account.id, account]));
const demoAccountByEmail = new Map<string, DemoAccount>(
  demoAccounts.map((account) => [account.email.toLowerCase(), account])
);

export function getDemoAccountById(id: string | null | undefined) {
  if (!id) {
    return null;
  }

  return demoAccountById.get(id) ?? null;
}

export function getDemoAccountByEmail(email: string | null | undefined) {
  if (!email) {
    return null;
  }

  return demoAccountByEmail.get(email.toLowerCase()) ?? null;
}
