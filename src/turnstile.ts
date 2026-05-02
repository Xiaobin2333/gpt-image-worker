export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstileToken(
  secret: string,
  token: string,
  remoteIp?: string,
): Promise<TurnstileVerifyResult> {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!resp.ok) return { success: false, errorCodes: ["http-" + resp.status] };
  const data = await resp.json<{ success: boolean; "error-codes"?: string[] }>();
  return { success: !!data.success, errorCodes: data["error-codes"] };
}
