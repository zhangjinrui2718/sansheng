import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(process.cwd(), "web/src");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function jsxText(node: ts.Node): string {
  let out = "";
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) { out += n.text; return; }
    // ⚠️ 字符串字面量必须单独处理 —— 否则 `"a" + "b"` 这种拼接会**整段丢掉**,
    //  于是长散文在扫描器眼里是短的 ⇒ **一个坏掉的检查返回一个看起来正常的答案**。
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { out += n.text; return; }
    if (ts.isNumericLiteral(n)) { out += "N"; return; }
    if (ts.isJsxExpression(n)) {
      if (n.expression === undefined) return; // {/* 注释 */}
      const ex = n.expression;
      if (ts.isStringLiteral(ex) || ts.isNoSubstitutionTemplateLiteral(ex)) out += ex.text;
      else if (ts.isTemplateExpression(ex)) out += ex.head.text + ex.templateSpans.map((s) => s.literal.text).join("");
      else if (ts.isJsxElement(ex) || ts.isJsxFragment(ex)) visit(ex);
      return;
    }
    if (ts.isJsxElement(n)) { for (const c of n.children) visit(c); return; }
    // ⚠️ **开标签的属性不是正文** —— `className="ss-note"` 里的 "ss-note" 是属性值,
    // 混进正文会让每一条都凭空多出 8 个字。
    if (ts.isJsxOpeningElement(n) || ts.isJsxClosingElement(n) || ts.isJsxSelfClosingElement(n)) return;
    if (ts.isJsxFragment(n)) { for (const c of n.children) visit(c); return; }
    if (ts.isConditionalExpression(n)) { visit(n.whenTrue); visit(n.whenFalse); return; }
    if (ts.isBinaryExpression(n)) { visit(n.left); visit(n.right); return; }
    if (ts.isParenthesizedExpression(n)) { visit(n.expression); return; }
    if (ts.isCallExpression(n) || ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) { out += "X"; return; }
    if (ts.isArrayLiteralExpression(n)) { for (const e of n.elements) visit(e); return; }
    n.forEachChild(visit);
  };
  if (ts.isJsxElement(node)) for (const c of node.children) visit(c);
  else if (ts.isJsxFragment(node)) for (const c of node.children) visit(c);
  else visit(node);
  return out.replace(/\s+/g, " ").trim();
}

// ── 完整口径:可见散文 = JSX 文本节点 / JSX 表达式里的字符串 / title= 属性值 ──
const runs: { f: string; line: number; n: number; t: string; kind: string }[] = [];
for (const abs of walk(WEB_SRC)) {
  const rel = abs.slice(WEB_SRC.length + 1);
  const src = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n: ts.Node, inAttr: boolean): void => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
    if (!inAttr) {
      if (ts.isJsxText(n)) {
        const t = norm(n.text);
        if (t.length > 60) runs.push({ f: rel, line, n: t.length, t, kind: "jsx" });
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const t = norm(n.text);
        if (t.length > 60) runs.push({ f: rel, line, n: t.length, t, kind: "str" });
      }
    }
    if (ts.isJsxAttribute(n) && n.name.text === "title" && n.initializer) {
      const v = n.initializer;
      if (ts.isStringLiteral(v)) {
        const t = norm(v.text);
        if (t.length > 60) runs.push({ f: rel, line, n: t.length, t, kind: "title" });
      }
    }
    const attr = ts.isJsxAttribute(n) || ts.isJsxOpeningElement(n) || ts.isJsxClosingElement(n) || ts.isJsxSelfClosingElement(n);
    n.forEachChild((c) => visit(c, inAttr || attr));
  };
  visit(sf, false);
}
console.log("=== 长散文(>60 字)===");
for (const r of runs.sort((a, b) => b.n - a.n)) console.log(`${String(r.n).padStart(4)} ${r.kind.padEnd(5)} ${r.f}:${r.line}  ${r.t.slice(0, 70)}`);
console.log("长散文条数", runs.length);

let over = 0, total = 0;
const blocks: { f: string; line: number; n: number; t: string }[] = [];
for (const abs of walk(WEB_SRC)) {
  const rel = abs.slice(WEB_SRC.length + 1);
  const src = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) {
      const open = n.openingElement;
      const cls = open.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.text === "className",
      );
      const val = cls && cls.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : "";
      if (/\bss-note\b/.test(val) || open.tagName.getText(sf) === "EmptyState") {
        const t = jsxText(n);
        if (t) { total++; blocks.push({ f: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, n: t.length, t }); }
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
}
for (const b of blocks.sort((a, b) => b.n - a.n)) {
  if (b.n > 60) { over++; console.log(`${String(b.n).padStart(4)}  ${b.f}:${b.line}  ${b.t.slice(0, 80)}`); }
}
console.log(`散文块 ${total} 条,>60 字 ${over} 条`);
