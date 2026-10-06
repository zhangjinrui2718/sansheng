import Database from "better-sqlite3";
import { renderProjectContext } from "../src/platform/runtime/projectContext.js";
const db = new Database("/Users/fuyao/.sansheng/sansheng.db", { readonly: true });
const c = renderProjectContext(db, "bm", null);
console.log(c.text);
console.log("\n=== 对照:项目内会话注入的是项目自己 ===");
const p = renderProjectContext(db, "bm", "pj_muvyas8ym8eqn2vh");
console.log(p.summary);
db.close();
