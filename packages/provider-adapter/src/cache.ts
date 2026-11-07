import type { Protocol, ProviderMessage } from "@knowself/contracts";

export function applyCacheControl(
  messages: ProviderMessage[],
  protocol: Protocol,
): ProviderMessage[] {
  if (protocol !== "anthropic") {
    return messages.map(({ cache_control: _, ...rest }) => rest);
  }
  return messages;
}
