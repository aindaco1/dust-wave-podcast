import {
  RequestValidationError,
  requiredText
} from "./validation";

export function validYouTubePrivacyStatus(
  value: unknown
): "private" | "unlisted" {
  const status = requiredText(value, "privacyStatus", 20);
  if (status !== "private" && status !== "unlisted") {
    throw new RequestValidationError(
      "privacyStatus must be private or unlisted"
    );
  }
  return status;
}
