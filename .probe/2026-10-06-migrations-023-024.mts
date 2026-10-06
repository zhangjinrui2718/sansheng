import Database from "better-sqlite3";
import { runMigrations } from "../src/platform/infra/migrations.js";
const db = new Database("/tmp/probe2.db");
const before = (db.prepare("SELECT MAX(version) v FROM schema_version").get() as {v:number}).v;
runMigrations(db);
const after = (db.prepare("SELECT MAX(version) v FROM schema_version").get() as {v:number}).v;
console.log(`迁移 ${before} → ${after}`);
const pc = db.pragma("table_info(projects)") as Array<{name:string}>;
const sc = db.pragma("table_info(project_sessions)") as Array<{name:string}>;
console.log("projects 有 version/parent_project_id:",
  pc.some(c=>c.name==="version") && pc.some(c=>c.name==="parent_project_id"));
console.log("project_sessions 有 kind/title:",
  sc.some(c=>c.name==="kind") && sc.some(c=>c.name==="title"));
console.log("存量项目全部 v1 / 无前身:", JSON.stringify(
  (db.prepare("SELECT version, parent_project_id FROM projects").all())));
console.log("存量会话全部 main:", JSON.stringify(
  db.prepare("SELECT DISTINCT kind FROM project_sessions").all()));
console.log("会话总数(未丢):", (db.prepare("SELECT COUNT(*) n FROM project_sessions").get() as {n:number}).n);
db.close();
