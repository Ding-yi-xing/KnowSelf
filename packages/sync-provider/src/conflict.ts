export function detectConflict(
  local: { updated_at: string },
  remote: { updated_at: string },
  base: { updated_at: string } | null,
): "local-wins" | "remote-wins" | "conflict" {
  if (!base) return "remote-wins";
  const la = local.updated_at > base.updated_at;
  const ra = remote.updated_at > base.updated_at;
  if (la && !ra) return "local-wins";
  if (!la && ra) return "remote-wins";
  if (la && ra) return "conflict";
  return "remote-wins";
}
