export type TipHandles = {
  cashApp: string | null;
  venmo: string | null;
};

export type TipLinks = {
  cashApp: string | null;
  venmo: string | null;
};

export class InvalidTipHandleError extends Error {}

function optionalHandle(value: unknown, prefix: string) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new InvalidTipHandleError("Tip handles must be text.");
  }
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(1) : trimmed;
}

function hasInput(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

export type TipProvider = "cashApp" | "venmo";

/**
 * One rule per provider, read by the DJ's form and by the route that stores
 * the handle. Both ask the same question of the same string: a form that were
 * looser would send a launch that fails after every track has uploaded, and a
 * form that were stricter would refuse a handle the room would have taken.
 *
 * A cashtag starts with a letter — "$1owl" is not a handle Cash App will ever
 * resolve — and a room's handles are fixed once it goes live, so a typo let
 * through here is a dead tip button for the whole night.
 */
const providerRules: Record<
  TipProvider,
  { prefix: string; pattern: RegExp; message: string }
> = {
  cashApp: {
    prefix: "$",
    pattern: /^[A-Za-z][A-Za-z0-9]{0,19}$/,
    message:
      "Enter a Cash App $cashtag that starts with a letter, 1 to 20 letters or numbers.",
  },
  venmo: {
    prefix: "@",
    pattern: /^[A-Za-z0-9_-]{5,30}$/,
    message:
      "Enter a Venmo username with 5 to 30 letters, numbers, hyphens, or underscores.",
  },
};

/**
 * What is wrong with one handle as typed, or null if nothing is — blank
 * included, since both handles are optional.
 */
export function tipHandleError(
  provider: TipProvider,
  value: string,
): string | null {
  if (!hasInput(value)) return null;
  const rule = providerRules[provider];
  return rule.pattern.test(optionalHandle(value, rule.prefix))
    ? null
    : rule.message;
}

export function normalizeTipHandles(input: {
  cashApp?: unknown;
  venmo?: unknown;
}): TipHandles {
  const cashApp = optionalHandle(input.cashApp, "$");
  const venmo = optionalHandle(input.venmo, "@");

  for (const provider of ["cashApp", "venmo"] as const) {
    const value = input[provider];
    if (!hasInput(value)) continue;
    const message = tipHandleError(provider, value as string);
    if (message) throw new InvalidTipHandleError(message);
  }

  return {
    cashApp: cashApp || null,
    venmo: venmo || null,
  };
}

export function tipLinksFor(handles: TipHandles): TipLinks {
  return {
    cashApp: handles.cashApp
      ? `https://cash.app/$${handles.cashApp}`
      : null,
    venmo: handles.venmo
      ? `https://account.venmo.com/u/${handles.venmo}`
      : null,
  };
}
