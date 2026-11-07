/**
 * 挖掘派生层 DDL：chat_message_intents / mining_graph_snapshots / semantic_llm_cache。
 * 逐字抄录 DESIGN-12 §5.3 / §4.6 与 DESIGN-14 §2.6 #3（新增表，可整层重建 D3）。
 */
export const MINING_DDL: readonly string[] = [
  // 逐消息意图（DESIGN-12 新增；派生层）。message_id 本身即回溯锚点（D4），不复制原文。
  `CREATE TABLE IF NOT EXISTS chat_message_intents (
    message_id      TEXT    PRIMARY KEY,
    intent          TEXT    NOT NULL
                            CHECK (intent IN ('consult','after_sales','business','work',
                                              'social','family','finance','notice','other')),
    confidence      REAL    NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    ambiguous       INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
    matched_rules   TEXT    NOT NULL DEFAULT '[]',
    produced_by     TEXT    NOT NULL DEFAULT '',
    computed_at     TEXT    NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(message_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_msg_intent ON chat_message_intents(intent, confidence)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_intent_produced ON chat_message_intents(produced_by)`,

  // 图谱快照（DESIGN-12 新增；派生层）。每次重算追加一行，保留最近 N 份。
  `CREATE TABLE IF NOT EXISTS mining_graph_snapshots (
    snapshot_id     TEXT    PRIMARY KEY,
    graph_kind      TEXT    NOT NULL
                            CHECK (graph_kind IN ('cooccurrence','value_rank')),
    scope_kind      TEXT    NOT NULL DEFAULT 'global'
                            CHECK (scope_kind IN ('global','direct','group')),
    scope_id        TEXT    NOT NULL DEFAULT '',
    time_from       TEXT,
    time_to         TEXT,
    params_json     TEXT    NOT NULL DEFAULT '{}',
    payload_json    TEXT    NOT NULL,
    node_count      INTEGER NOT NULL DEFAULT 0,
    edge_count      INTEGER NOT NULL DEFAULT 0,
    community_count INTEGER NOT NULL DEFAULT 0,
    produced_by     TEXT    NOT NULL DEFAULT '',
    computed_at     TEXT    NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_mining_graph_latest
     ON mining_graph_snapshots(graph_kind, scope_kind, scope_id, computed_at DESC)`,

  // 语义抽取 LLM 缓存（DESIGN-14 §2.6 #3，抖动抑制 + 成本节省）。派生层，可清空重建。
  // cache_key = sha256(prompt_version + '|' + provider_id + '|' + model_id + '|' + normalized_input)
  `CREATE TABLE IF NOT EXISTS semantic_llm_cache (
    cache_key       TEXT    PRIMARY KEY,
    prompt_version  TEXT    NOT NULL,
    provider_id     TEXT    NOT NULL,
    model_id        TEXT    NOT NULL,
    response_json   TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    hit_count       INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS idx_semantic_cache_ver
     ON semantic_llm_cache(prompt_version, provider_id, model_id)`,
];
