/**
 * 交付物类型 · 前端渲染判据与词表
 *
 * ── 这条判据错了会怎样 ──────────────────────────────────────────
 *
 * `bodyMode` 决定一条工件的正文是塞进沙箱 iframe 还是塞进 `<pre>`。
 * 它写反了的表现**不是报错,是空白**:把存量 23 条 markdown 交付物
 * (`deliverable_type IS NULL`)当成 `html_report` 渲染,iframe 里
 * `<pre>` 显示的那几行 markdown 就是**一片空白页** —— 而空白页看起来
 * 像「平台坏了」,不像「判据写反了」。
 *
 * 所以它必须是一个**能单测的纯函数**(而不是组件里内联的三元表达式),
 * 并且这里带上那条最容易写反的分支:**先看 kind,再看类型**。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArtifactKind, CodeServiceView, DeliverableType } from "@shared/types/platform";
import { DELIVERABLE_TYPES } from "../../src/platform/storage/repo/artifacts.js";
import {
  DELIVERABLE_TYPE_LABEL,
  DELIVERABLE_TYPE_TONE,
  deliverableTypeLabel,
  deliverableTypeTone,
} from "@/lib/vocab";
import { bodyMode, dockerCommands, htmlReportFileName, shortSha } from "@/lib/deliverable";
import { commitsRuntimeLabel } from "@/components/deliverable/CodeService";

const WEB_SRC = join(process.cwd(), "web/src");

function readWebSrc(rel: string): string {
  return readFileSync(join(WEB_SRC, rel), "utf8");
}

/** 去掉注释 —— 断言针对**代码**:注释里讨论「不许写成的形态」不该被判为违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(process.cwd(), p));
  }
  return out;
}

/** 全部 web/src 源码(仓库相对路径)—— iframe 扫描的范围。 */
const WALKED_WEB_FILES = walk(WEB_SRC);

const ALL_KINDS: ArtifactKind[] = [
  "decision", "note", "evidence", "hypothesis", "project_brief", "work_brief",
  "meeting_note", "review_finding", "change_record", "client_question", "deliverable",
];

describe("交付物 · 正文呈现方式(bodyMode)", () => {
  it("正样本:`deliverable` + `html_report` → 沙箱渲染", () => {
    expect(bodyMode({ kind: "deliverable", deliverableType: "html_report" })).toBe("html_report");
  });

  it("**存量交付物(NULL)按普通正文读** —— 真机 23 条,当 HTML 渲染就是 23 片空白", () => {
    expect(bodyMode({ kind: "deliverable", deliverableType: null })).toBe("text");
  });

  it("非交付物工件恒为 text(**先看 kind**,哪怕类型字段有值)", () => {
    for (const k of ALL_KINDS.filter((x) => x !== "deliverable")) {
      expect(bodyMode({ kind: k, deliverableType: null }), k).toBe("text");
      // 脏数据自检:类型字段存在不等于它是交付物。工具层禁止这种行,
      // 但读面**不能**因此崩掉或误渲染 —— 判据必须自己站得住。
      expect(bodyMode({ kind: k, deliverableType: "html_report" }), k).toBe("text");
    }
  });

  it("正样本:`deliverable` + `code_service` → 走代码服务那条渲染分支", () => {
    expect(bodyMode({ kind: "deliverable", deliverableType: "code_service" })).toBe("code_service");
  });

  it("**`code_service` 不能落进 text / html_report** —— 它的正文是 markdown,主体是坐标", () => {
    // 落进 html_report ⇒ 正文(一段 markdown 说明)被塞进沙箱 iframe = 一片空白;
    // 落进 text ⇒ 坐标(这一页真正要给人看的东西)**根本渲染不出来**。
    expect(bodyMode({ kind: "deliverable", deliverableType: "code_service" })).not.toBe("text");
    expect(bodyMode({ kind: "deliverable", deliverableType: "code_service" })).not.toBe("html_report");
  });

  it("负样本自检:判据真的在判,不是恒返回同一个值", () => {
    const seen = new Set(
      ALL_KINDS.flatMap((k) =>
        [null, "html_report", "code_service"].map((t) =>
          bodyMode({ kind: k, deliverableType: t as DeliverableType }),
        ),
      ),
    );
    expect([...seen].sort()).toEqual(["code_service", "html_report", "text"]);
  });
});

describe("代码服务 · 展示辅助(短 sha / 部署命令)", () => {
  // ⚠️ 2026-10-08 起坐标是**六项**(设计 §3.2a),`CodeServiceView` 多了
  // `servicePath` / `deliverableCommit` / `deliverableSubject` / `ignoredFiles`。
  // 这个夹具跟着换成新形状 —— 少一项就会让下面那条命令断言变成
  // 「docker build -t billing undefined」(可见地胡说,而不是静静地写对)。
  const META = (over: Partial<CodeServiceView> = {}): CodeServiceView => ({
    repoPath: "/w/proj", repoName: "billing", servicePath: "services/billing",
    branch: "main",
    headCommit: "0123456789abcdef0123456789abcdef01234567", headSubject: "交付计费服务",
    deliverableCommit: "89abcdef0123456789abcdef0123456789abcdef",
    deliverableSubject: "给计费服务加退款接口",
    commitCount: 3, dockerfile: "services/billing/Dockerfile", service: "billing", port: 8080,
    files: ["Dockerfile", "index.js", "package.json"], ignoredFiles: [], ...over,
  });

  it("短 sha 取 7 位;读不到就返回 null(界面上不许出现 undefined)", () => {
    expect(shortSha(META().headCommit)).toBe("0123456");
    expect(shortSha(null)).toBeNull();
  });

  it("**交付版本与 HEAD 是两个 sha** —— 短 sha 对两者都成立,不许拿一个冒充另一个", () => {
    expect(shortSha(META().deliverableCommit)).toBe("89abcde");
    expect(shortSha(META().deliverableCommit)).not.toBe(shortSha(META().headCommit));
  });

  it("两条命令由**核实过的坐标**生成 —— 构建上下文是交付物边界,端口来自交付物", () => {
    const c = dockerCommands(META());
    expect(c).not.toBeNull();
    // ⚠️ 构建上下文是 `servicePath`,**不是** `.`:仓库根还含 artifacts/ 与
    // work/,`docker build .` 会把内部工作区装进镜像(设计 §3.2a / §7)。
    expect(c!.build).toBe("docker build -t billing services/billing");
    expect(c!.run).toBe("docker run --rm -p 8080:8080 billing");
    // 负样本:坐标换了,命令必须跟着换(否则「生成」是假的)
    expect(dockerCommands(META({ service: "api", port: 3000, servicePath: "services/api" }))!.run)
      .toBe("docker run --rm -p 3000:3000 api");
    expect(dockerCommands(META({ servicePath: "services/api" }))!.build)
      .toBe("docker build -t billing services/api");
  });

  it("**缺服务名 / 端口 / 服务目录就不生成命令** —— 编一个默认值会让人照着错的命令去部署", () => {
    expect(dockerCommands(META({ service: null }))).toBeNull();
    expect(dockerCommands(META({ port: null }))).toBeNull();
    // 缺边界时不生成:`docker build -t billing .` 是一条会跑、但装错东西的命令。
    expect(dockerCommands(META({ servicePath: null }))).toBeNull();
  });
});

describe("代码服务 · 提交列表的三态(读不到 / 提交不可达都不是空列表)", () => {
  it("`ok` / `unavailable` / `unreachable` 三种 runtime 各有各的读法", () => {
    expect(commitsRuntimeLabel("unavailable")).toBe("读不到");
    // §3.2c:`reset --hard` 之后交付提交只剩 reflog ⇒ 读面报 unreachable,
    // 与「读不到盘」区分开(处置不同:一个是去看盘,一个是这版提交没了)。
    expect(commitsRuntimeLabel("unreachable")).toBe("提交已不可达");
    expect(commitsRuntimeLabel("unreachable")).not.toBe(commitsRuntimeLabel("unavailable"));
  });

  it("未知取值原样透出(不猜、也不悄悄折成「读不到」)", () => {
    expect(commitsRuntimeLabel("something_new")).toBe("something_new");
  });

  it("负样本自检:两个已知取值都不等于 `ok` —— 页面据此走「不渲染成空列表」的那一支", () => {
    expect(commitsRuntimeLabel("unavailable")).not.toBe("ok");
    expect(commitsRuntimeLabel("unreachable")).not.toBe("ok");
  });
});

/**
 * 渲染面的**源码级**判据(web 侧没有 jsdom,见 `c10-dead-code.test.ts` 文件头)。
 *
 * ── 这条判据为什么必须存在 ──────────────────────────────────────
 *
 * 正文改成**现读** `GET /api/artifacts/:id/content` 之后,最顺手的一条写法是
 * `<iframe src="/api/artifacts/:id/content">` —— **那条端点与页面同源**,于是
 * 模型写的 HTML 拿到本应用的来源,`sandbox=""` 连表达「不透明来源」的机会都没有。
 * 这条错误**不会报任何错**,只会静静地把结构性保证换成一次同源加载。
 *
 * 所以这里钉两件事:① 仍然 `srcDoc` + 字面 `sandbox=""`;② 全 `web/src` 里
 * **没有任何** `<iframe src=`(带 src 而不带 srcDoc 的开标签)。
 */
describe("HTML 报告 · 沙箱渲染判据(srcDoc + sandbox=\"\",且没有同源 src)", () => {
  /** 抽出源码里所有 `<iframe …>` 开标签(`[^>]` 跨行,JSX 属性可以分行写)。 */
  function iframeTags(src: string): string[] {
    return src.match(/<iframe\b[^>]*>/g) ?? [];
  }

  /**
   * 这个开标签是不是「同源 src」形态:有 `src=`,却没有 `srcDoc=`
   * (两者都在时以 `srcDoc` 为准,浏览器不会去请求 `src`)。
   */
  function isSameOriginSrc(tag: string): boolean {
    return /\ssrc=/.test(tag) && !/\ssrcDoc=/.test(tag);
  }

  /** 字面空值 sandbox —— 这一段的全部安全依据(不是 `sandbox={sandbox}`)。 */
  function hasEmptySandbox(src: string): boolean {
    return /sandbox=""/.test(src);
  }

  it("正负样本自检:扫描器对已知答案给出正确答案(坏掉的检查不等于检查失败)", () => {
    // 正样本:同源 src 的 frame **必须**被判出来
    const bad = `export const X = () => <iframe src="/api/artifacts/a1/content" title="t" />;`;
    expect(iframeTags(bad).filter(isSameOriginSrc)).toHaveLength(1);
    // 负样本:`srcDoc` + 空 sandbox 的 frame **必须**不被判出来
    const good = `export const X = () => <iframe sandbox="" srcDoc={html} title="t" />;`;
    expect(iframeTags(good).filter(isSameOriginSrc)).toHaveLength(0);
    // 判据的两种形态各自也要自检
    expect(hasEmptySandbox(good)).toBe(true);
    expect(hasEmptySandbox(`<iframe sandbox="allow-scripts" srcDoc={html} />`)).toBe(false);
    expect(hasEmptySandbox(`<iframe srcDoc={html} />`)).toBe(false);

    // ⚠️ 对**真文件**做内存变异:同一个判据必须由绿转红。
    // 「跑完没报错」不是判据,「把它改坏这条断言会红」才是。
    const real = stripComments(readWebSrc("components/deliverable/HtmlReport.tsx"));
    const noSandbox = real.replace('sandbox=""', 'sandbox="allow-scripts"');
    expect(noSandbox, "前提:变异真的改到了源码(改不动的话下面那条断言毫无意义)").not.toBe(real);
    expect(hasEmptySandbox(noSandbox)).toBe(false);

    const sameOrigin = real.replace("srcDoc={html}", `src="/api/artifacts/a1/content"`);
    expect(sameOrigin, "前提:变异真的改到了源码").not.toBe(real);
    expect(iframeTags(sameOrigin).filter(isSameOriginSrc)).toHaveLength(1);
  });

  it("HtmlReport.tsx 仍然:字面 `sandbox=\"\"` + `srcDoc`", () => {
    const src = stripComments(readWebSrc("components/deliverable/HtmlReport.tsx"));
    expect(hasEmptySandbox(src), "空值 sandbox 是结构性的安全保证 —— 改成属性变量或加 allow-scripts 都等于拆掉它").toBe(true);
    expect(src, "正文必须经 srcDoc 喂进 frame").toContain("srcDoc={html}");
    expect(iframeTags(src), "这个文件里应当只有一个 iframe(报告预览)").toHaveLength(1);
  });

  it("web/src 里没有任何 `<iframe src=`(同源加载模型写的 HTML)", () => {
    const offenders: string[] = [];
    for (const rel of WALKED_WEB_FILES) {
      const src = stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
      for (const tag of iframeTags(src).filter(isSameOriginSrc)) offenders.push(`${rel}: ${tag}`);
    }
    expect(offenders).toEqual([]);
  });

  it("正文走现读:**没有一处代码再读 `artifact.body` / `a.body`**", () => {
    const works = stripComments(readWebSrc("routes/Works.tsx"));
    expect(works, "正文是文件,`ArtifactView` 上已经没有 `body` 这个字段了").not.toMatch(/\bartifact\.body\b/);
    expect(works).not.toMatch(/\ba\.body\b/);
    // 正样本自检:这条正则对一个**必然含它**的串要给 true(防止断言恒真)
    expect(/\bartifact\.body\b/.test("const x = artifact.body.length;")).toBe(true);
    // 现读的入口必须真的被接上(HtmlReport / 普通正文两处)
    expect(stripComments(readWebSrc("components/deliverable/HtmlReport.tsx"))).toContain("useArtifactContent(");
  });
});

describe("交付物 · 下载文件名", () => {
  it("正样本:标题直接用", () => {
    expect(htmlReportFileName("美股交易平台 · 技术方案", "art_1")).toBe("美股交易平台 · 技术方案.html");
  });

  it("去掉文件系统不接受的字符(否则下载下来是一堆乱码名)", () => {
    expect(htmlReportFileName("方案:v1/最终?", "art_1")).toBe("方案v1最终.html");
    expect(htmlReportFileName('a<b>c|d"e*f', "art_1")).toBe("abcdef.html");
  });

  it("空标题 / 全非法字符 → 回落成带 id 的名字(**不许**空串)", () => {
    expect(htmlReportFileName("", "art_9")).toBe("交付-art_9.html");
    expect(htmlReportFileName("   ", "art_9")).toBe("交付-art_9.html");
    expect(htmlReportFileName("///", "art_9")).toBe("交付-art_9.html");
  });

  it("同名两份报告不会互相覆盖(回落名带 id;正常名同名是用户自己的选择)", () => {
    const a = htmlReportFileName("", "art_1");
    const b = htmlReportFileName("", "art_2");
    expect(a).not.toBe(b);
  });
});

describe("交付物 · 前端词表与代码侧闭集对齐", () => {
  it("标签表覆盖全部交付物类型,且不多不少", () => {
    expect(Object.keys(DELIVERABLE_TYPE_LABEL).sort()).toEqual([...DELIVERABLE_TYPES].sort());
    expect(Object.keys(DELIVERABLE_TYPE_TONE).sort()).toEqual([...DELIVERABLE_TYPES].sort());
  });

  it("兜底不猜:未知类型原样透出英文", () => {
    expect(deliverableTypeLabel("git_repo")).toBe("git_repo");
    expect(deliverableTypeTone("git_repo")).toBe("bone");
    expect(deliverableTypeLabel("html_report")).toBe("HTML 报告");
  });
});