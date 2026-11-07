import { Hono } from "hono";
import type { Context } from "hono";
import type { ProposalStatus, SourceStatus } from "@knowself/contracts";
import type { Runtime } from "../runtime";

const REQUIRED_NODE = ">=20.18 <21";
const SOURCE_STATUSES: SourceStatus[] = [
  "raw",
  "distilling",
  "pending_review",
  "completed",
  "rejected",
  "distill_failed",
];
const PROPOSAL_STATUSES: ProposalStatus[] = ["pending", "accepted", "edited", "rejected"];

export function systemRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  const bootAt = Date.now();

  // GET /api/system/status
  router.get("/status", (_c: Context) => {
    const uptime = Math.floor((Date.now() - bootAt) / 1000);
    const providers = runtime.providerAdapter.listHealth();
    const mcp = runtime.mcpHost.getStatus();
    const sourceStatusCounts = normalizeCounts(
      runtime.profileStore.sources.countByStatus(),
      SOURCE_STATUSES,
    );
    const proposalStatusCounts = normalizeCounts(
      runtime.profileStore.proposals.countByStatus(),
      PROPOSAL_STATUSES,
    );
    const sourceCount = Object.values(sourceStatusCounts).reduce((sum, count) => sum + count, 0);
    const conversations = readConversationStatus(runtime);
    const providerReady = providers.length > 0;
    const sqliteAvailable = Boolean(runtime.profileDb?.open);

    const status = {
      ready: {
        profile_store: true,
        context_router: true,
        provider_adapter: providerReady,
        mcp_host: mcp.all_ready,
        ingestion: true,
        overall: providerReady,
      },
      providers,
      mcp,
      retriever: {
        embedding_model_loaded: false,
        chunk_count: 0,
        last_full_index_at: null,
        last_incremental_at: null,
        degraded_to_fts5_only: false,
      },
      conversations,
      ingestion: {
        pending_proposal_count: proposalStatusCounts.pending,
        source_count: sourceCount,
        last_distill_at: runtime.profileStore.sources.latestDistillAt(),
        distill_provider_ready: providerReady,
        source_status_counts: sourceStatusCounts,
        proposal_status_counts: proposalStatusCounts,
      },
      environment: {
        node_version: process.versions.node,
        node_required: REQUIRED_NODE,
        node_ok: isSupportedNode(process.versions.node),
        platform: process.platform,
        arch: process.arch,
        sqlite_available: sqliteAvailable,
      },
      uptime_seconds: uptime,
      schema_version: 1 as const,
      app_version: "0.0.0",
      collected_at: new Date().toISOString(),
    };

    return Response.json(status);
  });

  return router;
}

function normalizeCounts<T extends string>(
  counts: Partial<Record<T, number>>,
  statuses: readonly T[],
): Record<T, number> {
  return Object.fromEntries(statuses.map((status) => [status, counts[status] ?? 0])) as Record<
    T,
    number
  >;
}

function readConversationStatus(runtime: Runtime): { total: number; latest_at: string | null } {
  try {
    const result = runtime.conversationStore.listConversations({ limit: 1, offset: 0 });
    return {
      total: result.total,
      latest_at: result.items[0]?.updated_at ?? null,
    };
  } catch {
    return { total: 0, latest_at: null };
  }
}

function isSupportedNode(version: string): boolean {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  return major === 20 && minor >= 18;
}
