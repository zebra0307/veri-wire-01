export type ApiError = {
  error: string;
  detail?: string;
  rule?: string;
};

export type SessionUser = {
  id: string;
  name: string | null;
  email: string | null;
  role: "USER" | "MODERATOR" | "ADMIN";
};

export type RoomRoleName = "OWNER" | "CONTRIBUTOR" | "VOTER" | "OBSERVER";
