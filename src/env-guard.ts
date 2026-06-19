/** Production/staging safety checks for Worker env bindings. */

export function isLocalDevFlag(value: string | undefined): boolean {
  const flag = (value || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function isProductionEnvironment(env: { ENVIRONMENT?: string }): boolean {
  const name = (env.ENVIRONMENT || "").trim().toLowerCase();
  return name === "production" || name === "prod";
}

export function assertSafeProductionConfig(env: {
  ENVIRONMENT?: string;
  LOCAL_DEV?: string;
  ADMIN_SURFACE_PUBLIC?: string;
  INVITE_PASS_SECRET?: string;
}): void {
  if (!isProductionEnvironment(env)) return;
  if (isLocalDevFlag(env.LOCAL_DEV)) {
    throw new Error("LOCAL_DEV must not be enabled in production");
  }
  if (String(env.ADMIN_SURFACE_PUBLIC || "").trim() === "1") {
    throw new Error("ADMIN_SURFACE_PUBLIC must not be enabled in production");
  }
  if (!(env.INVITE_PASS_SECRET || "").trim()) {
    throw new Error("INVITE_PASS_SECRET must be configured in production");
  }
}
