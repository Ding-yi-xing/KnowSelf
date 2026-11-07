/**
 * DDL barrel（DESIGN-13 §2.2）：单一真相源，逐字抄录 DESIGN-10 §2 + DESIGN-11 §4.3 + DESIGN-12。
 * 每个元素是一条独立 SQL；执行顺序与数组顺序一致，全部 `CREATE ... IF NOT EXISTS`，幂等可重跑。
 */
import { SUBJECT_DDL } from "./ddl/subject";
import { RELATION_DDL } from "./ddl/relation";
import { DERIVED_DDL } from "./ddl/derived";
import { RAW_DDL } from "./ddl/raw";
import { INGEST_DDL } from "./ddl/ingest";
import { MINING_DDL } from "./ddl/mining";

export const DDL_STATEMENTS: readonly string[] = [
  ...SUBJECT_DDL,
  ...RELATION_DDL,
  ...DERIVED_DDL,
  ...RAW_DDL,
  ...INGEST_DDL,
  ...MINING_DDL,
];
