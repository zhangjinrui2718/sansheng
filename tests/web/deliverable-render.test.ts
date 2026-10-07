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
import type { ArtifactKind, CodeServiceView, DeliverableType } from "@shared/types/platform";
import { DELIVERABLE_TYPES } from "../../src/platform/storage/repo/artifacts.js";
import {
  DELIVERABLE_TYPE_LABEL,
  DELIVERABLE_TYPE_TONE,
  deliverableTypeLabel,
  deliverableTypeTone,
} from "@/lib/vocab";
import { bodyMode, dockerCommands, htmlReportFileName, shortSha } from "@/lib/deliverable";

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
  const META = (over: Partial<CodeServiceView> = {}): CodeServiceView => ({
    repoPath: "/w/billing", repoName: "billing", branch: "main",
    headCommit: "0123456789abcdef0123456789abcdef01234567", headSubject: "交付计费服务",
    commitCount: 3, dockerfile: "Dockerfile", service: "billing", port: 8080,
    files: ["Dockerfile", "index.js", "package.json"], ...over,
  });

  it("短 sha 取 7 位;读不到就返回 null(界面上不许出现 undefined)", () => {
    expect(shortSha(META().headCommit)).toBe("0123456");
    expect(shortSha(null)).toBeNull();
  });

  it("两条命令由**核实过的坐标**生成 —— 端口来自交付物,不是模型手写的", () => {
    const c = dockerCommands(META());
    expect(c).not.toBeNull();
    expect(c!.build).toBe("docker build -t billing .");
    expect(c!.run).toBe("docker run --rm -p 8080:8080 billing");
    // 负样本:坐标换了,命令必须跟着换(否则「生成」是假的)
    expect(dockerCommands(META({ service: "api", port: 3000 }))!.run)
      .toBe("docker run --rm -p 3000:3000 api");
  });

  it("**缺服务名或端口就不生成命令** —— 编一个默认端口会让人照着错的命令去部署", () => {
    expect(dockerCommands(META({ service: null }))).toBeNull();
    expect(dockerCommands(META({ port: null }))).toBeNull();
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