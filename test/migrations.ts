import initSql from "../migrations/0001_init.sql?raw";

export interface TestMigration {
  name: string;
  queries: string[];
}

export const migrations: TestMigration[] = [
  {
    name: "0001_init",
    queries: initSql
      .split(";")
      .map((q) => q.trim())
      .filter((q) => q.length > 0),
  },
];
