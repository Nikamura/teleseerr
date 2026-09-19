import { ClientError, isRecord } from "./http.js";
import type { RequestDetails } from "./seerr/client.js";

const events = new Set([
  "MEDIA_AVAILABLE",
  "MEDIA_APPROVED",
  "MEDIA_AUTO_APPROVED",
  "MEDIA_DECLINED",
  "MEDIA_FAILED",
]);

export function webhookEvent(payload: unknown): { type: string; requestId: number } | null {
  if (!isRecord(payload) || typeof payload["notification_type"] !== "string")
    throw new ClientError(400, "Invalid webhook event");
  const type = payload["notification_type"];
  if (!events.has(type)) return null;
  const request = payload["request"];
  if (!isRecord(request)) throw new ClientError(400, "Missing webhook request");
  const rawId = request["request_id"];
  if ((typeof rawId !== "string" && typeof rawId !== "number") || !/^\d+$/.test(String(rawId)))
    throw new ClientError(400, "Invalid request ID");
  const requestId = Number(rawId);
  if (!Number.isSafeInteger(requestId) || requestId <= 0)
    throw new ClientError(400, "Invalid request ID");
  return { type, requestId };
}

export function matchesRequest(type: string, request: RequestDetails): boolean {
  switch (type) {
    case "MEDIA_APPROVED":
    case "MEDIA_AUTO_APPROVED":
      return request.status === 2;
    case "MEDIA_DECLINED":
      return request.status === 3;
    case "MEDIA_FAILED":
      return request.status === 4;
    case "MEDIA_AVAILABLE":
      return (
        request.status === 5 ||
        (request.status === 2 &&
          (request.is4k ? request.media?.status4k : request.media?.status) === 5)
      );
    default:
      return false;
  }
}
