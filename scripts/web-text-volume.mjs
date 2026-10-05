#!/usr/bin/env node
/**
 * web 展示层「屏上文字量」估算(批次 UI U4 的验收口径)
 *
 * 为什么需要这个:「字太多了」是个主观说法,重构完凭什么说变好了?与其靠感觉,
 * 不如给一个每次都能重跑的粗口径指标。
 *
 * 口径(**刻意保守,只算最硬的那部分**):
 *   1. 剥掉所有注释(`/* *\/` 与 `//` 行)—— 注释里的字一个也不算数,
 *      反正它不上屏;但这同时意味着「把字从页面挪进注释」会被算成改善,
 *      这是设计意图(字还在仓库里,只是不再要求所有人读),不是作弊。
 *   2. 只统计**中文字符** + **中英混排标签**里的中文部分。
 *   3. 统计范围是「引号内 / JSX 文本节点」的字符串字面量 —— 即真的会渲染的文案。
 *
 * 明确不算的:英文 id(communicator / waiting_for_decision)、数字、单位、
 * 纯代码标识符、文件名与行号引用。
 *
 * 用法:
 *   node scripts/web-text-volume.mjs               # 当前工作树
 *   node scripts/web-text-volume.mjs <ref>         # 某个 git ref(如 b30a3d0)
 *   node scripts/web-text-volume.mjs --compare a b # 两个 ref 对比
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FILES = [
  "web/src/App.tsx",
  "web/src/components/shell/TopBar.tsx",
  "web/src/components/shell/HistoryRail.tsx",
  "web/src/components/shell/AgentPanel.tsx",
  "web/src/components/chat/ChatSurface.tsx",
  "web/src/components/chat/ChatComposer.tsx",
  "web/src/components/chat/MessageList.tsx",
  "web/src/components/chat/ThinkingBlock.tsx",
  "web/src/components/chat/ToolCallCard.tsx",
  "web/src/components/settings/SettingsPanel.tsx",
  "web/src/routes/Agents.tsx",
  // ⚠️ 这份清单**必须**与 `web/src/routes/` 实际有的文件对齐 —— 列错的表现是
  // 「这一页的文字量静默不算」(脚本照常退出 0,而结果是假的;见 AGENTS.md 的
  // 「三类静默失败」#3)。2026-10-06:工件页已并入工作项页(Artifacts.tsx →
  // Works.tsx);Goals.tsx / Timeline.tsx 是更早删掉的页面,一并清掉。
  "web/src/routes/Works.tsx",
  "web/src/routes/Memory.tsx",
  // harness 页已并入成员页(2026-10-06)⇒ 文件搬到 components 下
  "web/src/components/members/RoleHarness.tsx",
];

/**
 * 去掉块注释与行注释(字符串里的 // 不处理,web 源码里没有这种写法)。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 精确剥掉某个 JSX 属性(attr 后面跟 `="…"` 或 `={…}`)的值。
 *
 * 为什么不能用正则一刀切:`title={`${t.id} · 依赖 ${strList(t.dependsOn)…}`}`
 * 这种写法里属性值内部**自己就有花括号**(模板插值),`[^}]*` 会在第一个 `}`
 * 处停下,把后半截当成普通字符串留下 —— 于是「已经搬进悬停提示里的字」
 * 又被算成「屏上字」,度量直接失真。只能按花括号配平来切。
 */
function stripAttrValue(src, attr) {
  const marker = `${attr}=`;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf(marker, i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    // 只认独立的属性位置(前面不是标识符字符),避免误伤 xxxTitle= 之类
    const prev = at === 0 ? "" : src[at - 1];
    if (/[A-Za-z0-9_$]/.test(prev)) {
      out += src.slice(i, at + marker.length);
      i = at + marker.length;
      continue;
    }
    out += src.slice(i, at + marker.length);
    let j = at + marker.length;
    if (src[j] === '"') {
      const end = src.indexOf('"', j + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src[j] !== "{") {
      i = j;
      continue;
    }
    // 花括号配平
    let depth = 0;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

/**
 * 常量名后缀 —— 这些名字在本项目里的约定是「说明性文案,不是界面元素」。
 * 例:WAIT_ESTIMATE_NOTE / LANE_HINT / EMPTY_HINT / ..._TITLE。
 */
const HIDDEN_CONST_SUFFIX = /_(NOTE|HINT|TITLE|DESC|DESCRIPTION|HELP|TOOLTIP|SUMMARY|LABEL)$/;

/**
 * 剔除「**只**在隐藏位置被引用」的模块级常量。
 *
 * 为什么需要:网页把长解释写成
 *   ```tsx
 *   const WAIT_ESTIMATE_NOTE = "等待时长 = 现在 − 工件 updatedAt,是估算值:…";
 *   …
 *   <Disclosure summary="等待时长怎么算的">{WAIT_ESTIMATE_NOTE}</Disclosure>
 *   ```
 * 上一节已经抹掉了 `<Disclosure>` 的内容,但**常量声明本身还在文件里**,
 * 于是那 60 多个字又被算成「屏上字」。
 *
 * 判据:剥掉隐藏位置之后,若该标识符在剩余代码里**一次都不出现**(只剩声明),
 * 说明它确实只被隐藏位置引用 → 从度量中剔除。反之(还有可见引用)就保留。
 * 不做真正的引用分析,但这个判据在本项目的写法下不会误判:
 * 同一常量若也出现在可见位置,剥完之后那次引用仍在。
 */
function stripHiddenOnlyConsts(src) {
  // 值的形态有三种,都是本项目里「说明性文案」的常见写法:
  //   ① 字符串字面量,可能用 `+` 串多段;
  //   ② 对象字面量(`const X_TITLE: Record<…> = { … }`,键是枚举、值是文案);
  //   ③ 包着 JSX 片段的括号(`const X_NOTE = (<>…</>)`)。
  // 三种都必须**整条**吃掉 —— 只吃掉第一段的话,后面的 `"…"(…)+ "…"` 会留在
  // 源码里被当成普通可见文案再数一遍,这正是第一版度量失真的原因。
  const LITERAL = '(?:"(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)';
  const VALUE = [
    `${LITERAL}(?:\\s*\\+\\s*${LITERAL})*`, // ①
    "\\{[^{}]*\\}", // ②
    "\\(<>[\\s\\S]*?</>\\)", // ③
  ].join("|");
  const decls = [
    ...src.matchAll(new RegExp(`\\bconst\\s+([A-Za-z0-9_]+)\\s*(?::[^=]+)?=\\s*(${VALUE})`, "g")),
  ];
  let out = src;
  for (const d of decls) {
    const name = d[1];
    if (!HIDDEN_CONST_SUFFIX.test(name)) continue;
    if (!/[一-鿿]/.test(d[2] ?? "")) continue;
    const uses = [...out.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
    if (uses > 1) continue; // 除声明外还有引用 → 可见
    out = out.replace(d[0], `const ${name} = ""`);
  }
  return out;
}

/**
 * 去掉**默认不可见**的文案(仅 `visible` 模式)。
 *
 * 这一步是整个度量成立的关键。2026-10-02 那一批的做法是:把「为什么这么算」
 * 的解释从句子里搬进 `title=`(悬停)与 `<Disclosure>`(点开),并搬进文件注释。
 * 如果只数「文件里有多少中文字符串字面量」,前后是平的 —— 所有字都还在,
 * 只是不再要求所有人读。那样的度量会逼着下一批**为了刷分去删真信息**,
 * 正好和反造假纪律相反。
 *
 * 所以这里数的是**默认出现在屏幕上的字**:
 *   - `title=` / `hintTitle=` 的值 —— 悬停才出现,不算;
 *   - `<Disclosure>…</Disclosure>` 整块 —— 默认收起,不算;
 *   - 只在隐藏位置被引用的 `*_NOTE` / `*_HINT` 之类模块级常量 —— 不算;
 *   - `Clamp` 里的内容**算**(它默认露出 2–3 行,是真在屏幕上的)。
 */
function stripHiddenText(src) {
  return stripHiddenOnlyConsts(
    stripAttrValue(stripAttrValue(src, "title"), "hintTitle").replace(
      /<Disclosure\b[\s\S]*?<\/Disclosure>/g,
      "<Disclosure/>",
    ),
  );
}

/** 取出双引号 / 单引号 / 模板字面量里的字符串(足够覆盖本项目的写法)。 */
function stringLiterals(src) {
  return src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
}

/**
 * JSX 文本节点:`>` 与 `<` 之间的裸文字(>字母数字或空白<)。
 * 只取长度 ≥ 1 的,避免把 `=>` 之类误判进来。
 */
function jsxTextNodes(src) {
  return src.match(/>\s*([^<>{}\n][^<>{}]*?)\s*</g) ?? [];
}

/**
 * 量一个字文件里「默认上屏」的中文字数。
 * @param src  源文件内容
 * @param mode "visible" = 只数默认可见的(默认);"all" = 连 title/折叠里的一起数。
 */
export function measure(src, mode = "visible") {
  let clean = stripComments(src);
  if (mode === "visible") clean = stripHiddenText(clean);
  const chunks = [...stringLiterals(clean), ...jsxTextNodes(clean)];
  let cjk = 0;
  for (const chunk of chunks) {
    // 去掉转义序列与代码插值,只留看得见的字
    const visible = chunk.replace(/\\n|\\t|\\"/g, "").replace(/\$\{[^}]*\}/g, "");
    cjk += (visible.match(/[一-鿿]/g) ?? []).length;
  }
  return cjk;
}

function readAll(ref, mode) {
  const out = new Map();
  for (const f of FILES) {
    let src;
    try {
      src =
        ref === null
          ? readFileSync(f, "utf8")
          : execSync(`git show ${ref}:${f}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue; // 该 ref 上还没有这个文件
    }
    out.set(f, measure(src, mode));
  }
  return out;
}

const argv = process.argv.slice(2);
/**
 * 只有**直接当脚本跑**时才打印报表。被 import 时(测试里 import `measure`)
 * 必须安静 —— 否则每跑一次 vitest 都会在输出里糊一张表。
 */
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (!isMain) {
  // 被 import:只导出 API,不执行 CLI。
} else {
  main();
}

function main() {
  const MODE = argv.includes("--all") ? "all" : "visible";
  /** 去掉 flag(含 --compare 本身)后的位置参数。 */
  const positional = argv.filter((a) => !a.startsWith("--"));
  const COMPARE = argv[0] === "--compare";

  if (COMPARE) {
    const a = readAll(positional[0] ?? null, MODE);
    const b = readAll(positional[1] ?? null, MODE);
    let ta = 0;
    let tb = 0;
    console.log(
      `默认上屏中文字数(${MODE})  ${positional[0] ?? "工作树"} → ${positional[1] ?? "工作树"}`,
    );
    console.log("-".repeat(72));
    for (const f of FILES) {
      const va = a.get(f) ?? 0;
      const vb = b.get(f) ?? 0;
      ta += va;
      tb += vb;
      if (va === vb) continue;
      const delta = vb - va;
      const pct = va === 0 ? "" : ` (${Math.round((delta / va) * 100)}%)`;
      console.log(
        `${f.replace("web/src/", "").padEnd(30)} ${String(va).padStart(4)} → ${String(vb).padStart(4)}  ${delta >= 0 ? "+" : ""}${delta}${pct}`,
      );
    }
    console.log("-".repeat(72));
    console.log(
      `${"合计".padEnd(30)} ${String(ta).padStart(4)} → ${String(tb).padStart(4)}  ${tb - ta >= 0 ? "+" : ""}${tb - ta} (${ta === 0 ? "—" : Math.round(((tb - ta) / ta) * 100) + "%"})`,
    );
    return;
  }

  const ref = positional[0] ?? null;
  const m = readAll(ref, MODE);
  let total = 0;
  for (const [f, v] of m) {
    total += v;
    console.log(`${f.replace("web/src/", "").padEnd(30)} ${String(v).padStart(4)}`);
  }
  console.log("-".repeat(40));
  console.log(`${ref ?? "工作树"} 合计(默认上屏) ${total}`);
}
