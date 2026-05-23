// Thin fetch wrapper over the BoringOS tool dispatcher.
// Every tool lives at /api/tools/<module>.<name> and accepts a JSON
// body that matches the tool's Zod schema.
//
// Token is read from localStorage("boringos.token") — the shell's
// AuthProvider writes it there on login. This avoids a React context
// dependency so the function works in both hook and non-hook call sites.

const TOOL_BASE = "/api/tools";

function getToken(): string | null {
  return typeof window !== "undefined"
    ? window.localStorage.getItem("boringos.token")
    : null;
}

export async function callTool<TInput, TOutput>(
  name: string,
  input: TInput,
): Promise<TOutput> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${TOOL_BASE}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: ToolError };
    throw Object.assign(new Error(body.error?.message ?? `Tool ${name} failed`), {
      toolError: body.error,
    });
  }

  const body = (await res.json()) as { result?: TOutput; data?: TOutput };
  return (body.result ?? body.data) as TOutput;
}

export interface ToolError {
  code:
    | "invalid_input"
    | "not_found"
    | "permission_denied"
    | "upstream_unavailable"
    | "rate_limited"
    | "conflict"
    | "internal";
  message: string;
  retryable?: boolean;
}

export type ToolResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: ToolError };
