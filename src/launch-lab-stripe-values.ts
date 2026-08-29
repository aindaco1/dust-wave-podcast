export type LaunchLabStripeErrorNamespace =
  | "launch_lab"
  | "launch_lab_hosted";

export function createLaunchLabStripeValueReaders(
  errorNamespace: LaunchLabStripeErrorNamespace
) {
  function providerId(value: unknown, prefix: string): string {
    const text = String(value ?? "");
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{6,128}$`).test(text)) {
      throw new Error(`${errorNamespace}_invalid_${prefix}_id`);
    }
    return text;
  }

  function nestedId(value: unknown, prefix: string): string | null {
    if (typeof value === "string") {
      try {
        return providerId(value, prefix);
      } catch {
        return null;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return nestedId((value as Record<string, unknown>).id, prefix);
    }
    return null;
  }

  return {
    providerId,
    nestedId,
    positiveInteger,
    safeErrorCode
  };
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown_error";
  return value.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 80);
}
