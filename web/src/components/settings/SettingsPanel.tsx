import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "@/stores/settings";
import { resetData } from "@/lib/api";
import type { ProviderConfig, ThinkingLevel } from "@shared/types/settings";

/** 编辑中的 provider 草稿。apiKey="" 表示「不改动」(服务端会保留旧真值) */
interface DraftProvider {
  id: string; // 已有 id;新建时为空,保存时服务端分配
  label: string;
  provider: string;
  modelId: string;
  apiKey: string; // "" = 未改动
  hasApiKey: boolean; // 服务端来的,仅用于 placeholder
  baseUrl: string;
  thinkingLevel: ThinkingLevel;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

function toDraft(p: ProviderConfig): DraftProvider {
  return {
    id: p.id,
    label: p.label,
    provider: p.provider,
    modelId: p.modelId,
    apiKey: "", // 不回显真值/掩码,留空表示不改
    hasApiKey: p.hasApiKey,
    baseUrl: p.baseUrl ?? "",
    thinkingLevel: p.thinkingLevel,
  };
}

export function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const catalog = useSettingsStore((s) => s.providers);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadProviders = useSettingsStore((s) => s.loadProviders);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const [drafts, setDrafts] = useState<DraftProvider[]>([]);
  const [activeId, setActiveId] = useState("");
  const [cwd, setCwd] = useState("");
  const [personaName, setPersonaName] = useState("三生");
  const [saved, setSaved] = useState<null | "ok" | "err">(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
    loadProviders();
  }, [loadSettings, loadProviders]);

  // settings 到位后初始化草稿
  useEffect(() => {
    if (!settings) return;
    setDrafts(settings.providers.map(toDraft));
    setActiveId(settings.activeProviderId);
    setCwd(settings.cwd);
    setPersonaName(settings.personaName);
  }, [settings]);

  const catalogById = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);

  function updateDraft(id: string, patch: Partial<DraftProvider>) {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function addProvider() {
    const first = catalog[0];
    const tempId = `new_${Date.now().toString(36)}`;
    setDrafts((ds) => [
      ...ds,
      {
        id: tempId,
        label: first?.name ?? "新 provider",
        provider: first?.id ?? "",
        modelId: first?.models[0]?.id ?? "",
        apiKey: "",
        hasApiKey: false,
        baseUrl: "",
        thinkingLevel: "medium",
      },
    ]);
    if (!activeId) setActiveId(tempId);
  }

  function removeProvider(id: string) {
    setDrafts((ds) => {
      const next = ds.filter((d) => d.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? "");
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSaved(null);
    try {
      // 新建的(id 以 new_ 开头)不带 id,让服务端分配
      const providers = drafts.map((d) => ({
        ...(d.id.startsWith("new_") ? {} : { id: d.id }),
        label: d.label,
        provider: d.provider,
        modelId: d.modelId,
        apiKey: d.apiKey, // "" → 服务端保留旧值
        baseUrl: d.baseUrl || undefined,
        thinkingLevel: d.thinkingLevel,
      }));
      let activeProviderId = activeId;
      if (activeProviderId.startsWith("new_")) {
        // 新建的 active:保存后服务端会重新分配 id,这里先留空让服务端取第一个
        activeProviderId = "";
      }
      await saveSettings({
        providers: providers as ProviderConfig[],
        activeProviderId,
        cwd,
        personaName,
      });
      setSaved("ok");
      // 清空 apiKey 输入(已保存)
      setDrafts((ds) => ds.map((d) => ({ ...d, apiKey: "", hasApiKey: d.hasApiKey || !!d.apiKey })));
      setTimeout(() => setSaved(null), 1800);
    } catch {
      setSaved("err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-serif text-2xl" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
            设置
          </h1>
          <p className="sansheng-text-mute mt-1" style={{ fontSize: 13 }}>
            可配置多个 provider,选一个作为「当前」使用
          </p>
        </div>
        <button className="sansheng-button" onClick={addProvider} style={{ padding: "6px 12px" }}>
          + 添加 provider
        </button>
      </div>

      {drafts.length === 0 && (
        <div
          className="rounded-md p-6 text-center sansheng-text-mute"
          style={{ background: "var(--ink-2)", border: "1px dashed var(--ink-3)", fontSize: 13 }}
        >
          还没有配置任何 provider。点右上角「+ 添加 provider」开始。
        </div>
      )}

      <div className="flex flex-col gap-4">
        {drafts.map((d) => {
          const isActive = d.id === activeId;
          const cat = catalogById.get(d.provider);
          const models = cat?.models ?? [];
          return (
            <section
              key={d.id}
              className="sansheng-card-elevated p-4"
              style={{
                borderColor: isActive ? "var(--jade)" : "var(--ink-3)",
                boxShadow: isActive ? "var(--shadow-jade-glow)" : undefined,
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {isActive ? (
                    <span
                      className="font-mono sansheng-text-jade"
                      style={{ fontSize: 11, border: "1px solid var(--jade)", borderRadius: 4, padding: "1px 6px" }}
                    >
                      ● 当前
                    </span>
                  ) : (
                    <button
                      className="sansheng-button"
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => setActiveId(d.id)}
                    >
                      设为当前
                    </button>
                  )}
                </div>
                <button
                  className="sansheng-button sansheng-text-cinnabar"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => removeProvider(d.id)}
                >
                  删除
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="备注名">
                  <input
                    className="sansheng-input sansheng-input-block"
                    value={d.label}
                    onChange={(e) => updateDraft(d.id, { label: e.target.value })}
                    placeholder="如:MiniMax 主力"
                  />
                </Field>
                <Field label="Provider">
                  <select
                    className="sansheng-input sansheng-input-block"
                    value={d.provider}
                    onChange={(e) => {
                      const pid = e.target.value;
                      const firstModel = catalogById.get(pid)?.models[0]?.id ?? "";
                      updateDraft(d.id, { provider: pid, modelId: firstModel });
                    }}
                  >
                    <option value="">— 选择 —</option>
                    {catalog.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.models.length})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model">
                  <select
                    className="sansheng-input sansheng-input-block"
                    value={d.modelId}
                    onChange={(e) => updateDraft(d.id, { modelId: e.target.value })}
                    disabled={models.length === 0}
                  >
                    {models.length === 0 && <option value="">(先选 provider)</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.contextWindow ? ` · ${m.contextWindow}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="思考">
                  <select
                    className="sansheng-input sansheng-input-block"
                    value={d.thinkingLevel}
                    onChange={(e) => updateDraft(d.id, { thinkingLevel: e.target.value as ThinkingLevel })}
                  >
                    {THINKING_LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="API Key" full>
                  <input
                    type="password"
                    className="sansheng-input sansheng-input-block"
                    value={d.apiKey}
                    onChange={(e) => updateDraft(d.id, { apiKey: e.target.value })}
                    placeholder={d.hasApiKey ? "(已保存,留空保持不变)" : "粘贴 API Key"}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Base URL" full>
                  <input
                    className="sansheng-input sansheng-input-block"
                    value={d.baseUrl}
                    onChange={(e) => updateDraft(d.id, { baseUrl: e.target.value })}
                    placeholder="(可选)自定义 gateway,如 https://api.minimax.cn/anthropic"
                  />
                </Field>
              </div>
            </section>
          );
        })}
      </div>

      <section className="sansheng-card-elevated p-4">
        <h2 className="font-serif mb-3" style={{ color: "var(--bone)", fontSize: 14, letterSpacing: ".04em" }}>
          全局
        </h2>
        <div className="flex flex-col gap-3">
          <Field label="显示名">
            <input className="sansheng-input sansheng-input-block" value={personaName} onChange={(e) => setPersonaName(e.target.value)} />
          </Field>
          <Field label="工作目录">
            <input className="sansheng-input sansheng-input-block" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </Field>
          {/* 批次 UI U4:这里原本是**两段**说明("工作目录 = 三生跑命令 / 读写文件的根…"
              与"默认工作目录是 ~/sansheng-workspace…")。合并成一句;细节靠 title。
              出厂默认见 store.ts defaultWorkspaceDir(批次 6 起从 $HOME 改为
              ~/sansheng-workspace,且只对出厂默认自动建目录)。 */}
          <p
            className="sansheng-text-mute"
            style={{ fontSize: 11 }}
            title="工作目录 = 三生跑命令 / 读写文件的根,Pi 工具相对它解析路径。出厂默认 ~/sansheng-workspace(首次启动自动创建);可改成任意绝对路径,需自行创建,系统不会代建。"
          >
            agent 跑命令、读写文件的根。默认 <code>~/sansheng-workspace</code>(自动创建)。
          </p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button className="sansheng-button-primary" onClick={save} disabled={saving} style={{ padding: "8px 16px" }}>
          {saving ? "保存中…" : "保存"}
        </button>
        {saved === "ok" && <span className="sansheng-text-jade" style={{ fontSize: 12 }}>✓ 已保存,下次发消息生效</span>}
        {saved === "err" && <span className="sansheng-text-cinnabar" style={{ fontSize: 12 }}>✗ 保存失败</span>}
      </div>

      {/* —— 危险区:M2 重置按钮 —— */}
      <ResetSection />
    </div>
  );
}

/** 危险区:重置 Sansheng */
function ResetSection() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "ok" | "err">(null);
  const [info, setInfo] = useState<string>("");

  async function onReset() {
    if (busy) return;
    const ok = window.confirm(
      "确认重置 Sansheng?\n\n将删除:所有项目 / 工作项 / 工件 / 配置 / API key / 记忆片段。\n日志会保留。\n\n需要重启 server 才能重新初始化。",
    );
    if (!ok) return;
    setDone(null);
    setInfo("");
    setBusy(true);
    try {
      // 经 lib/api.ts 的 resetData() —— 页面不许散落裸 fetch(项目纪律)。
      // ⚠️ 该端点不在平台冻结契约的接口面里,见 api.ts 里的说明。
      const data = await resetData();
      setDone("ok");
      setInfo(
        `已删除 ${data.removed.length} 项${data.failed.length > 0 ? `,失败 ${data.failed.length}` : ""}。请运行 sansheng stop && sansheng start`,
      );
    } catch (err) {
      setDone("err");
      setInfo(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="sansheng-card-elevated p-4"
      style={{ border: "1px solid var(--cinnabar)", borderColor: "rgba(199, 107, 74, 0.35)" }}
    >
      <h2
        className="font-serif mb-2"
        style={{ color: "var(--cinnabar)", fontSize: 14, letterSpacing: ".04em" }}
      >
        危险区
      </h2>
      {/* 批次 UI U4:这段说明与 window.confirm 里的那段**逐条重复** —— 点按钮之前
          说一遍,点下去还要再确认一遍。屏幕上只留 confirm 弹窗那一版。 */}
      <div className="flex items-center gap-3">
        <button
          onClick={onReset}
          disabled={busy}
          className="sansheng-button"
          title="删除数据库、密钥环、设置与 Pi 会话目录(日志保留)"
          style={{
            padding: "8px 16px",
            color: "var(--cinnabar)",
            borderColor: "var(--cinnabar)",
          }}
        >
          {busy ? "重置中…" : "重置 Sansheng"}
        </button>
        {done === "ok" && (
          <span className="sansheng-text-jade" style={{ fontSize: 12 }}>
            ✓ {info}
          </span>
        )}
        {done === "err" && (
          <span className="sansheng-text-cinnabar" style={{ fontSize: 12 }}>
            ✗ {info}
          </span>
        )}
      </div>
    </section>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

