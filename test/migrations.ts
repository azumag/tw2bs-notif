import initSql from "../migrations/0001_init.sql?raw";
import connectionsSql from "../migrations/0002_connections.sql?raw";
import supportSql from "../migrations/0003_support.sql?raw";
import subCheckSql from "../migrations/0004_sub-check.sql?raw";
import bskySessionsSql from "../migrations/0005_bsky-sessions.sql?raw";
import postPreferenceSql from "../migrations/0006_post-preference.sql?raw";

export interface TestMigration {
  name: string;
  queries: string[];
}

function splitQueries(sql: string): string[] {
  return sql
    .split(";")
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

export const migrations: TestMigration[] = [
  { name: "0001_init", queries: splitQueries(initSql) },
  { name: "0002_connections", queries: splitQueries(connectionsSql) },
  { name: "0003_support", queries: splitQueries(supportSql) },
  { name: "0004_sub-check", queries: splitQueries(subCheckSql) },
  { name: "0005_bsky-sessions", queries: splitQueries(bskySessionsSql) },
  { name: "0006_post-preference", queries: splitQueries(postPreferenceSql) },
];
