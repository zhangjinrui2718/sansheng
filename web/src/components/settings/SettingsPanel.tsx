import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settings";
import type { SettingsPublic } from "@shared/types/settings";

/**
 * Settings Panel · provider + model + API key + thinking level
 * 简洁表单,保存后下次启动生效。
 */
export function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const providers = useSettingsStore((s) => s.providers);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadProviders = useSettingsStore((s) => s.loadProviders);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const [providerId, setProviderId] = useState("anthropic");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<"off" | "minimal" | "low" | "medium" | "high">("medium");
  const [cwd, setCwd] = useState("");
  const [personaName, setPersonaName] = useState("三生");
  const [baseUrl, setBaseUrl] = useState("");
  const [saved, setSaved] = useState<null | "ok" | "err">(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
    loadProviders();
  }, [loadSettings, loadProviders]);

  useEffect(() => {
    if (!settings) return;
    setProviderId(settings.provider);
    setModelId(settings.modelId);
    setThinkingLevel(settings.thinkingLevel);
    setCwd(settings.cwd);
    setPersonaName(settings.personaName);
    setBaseUrl(settings.baseUrl ?? "");
    // apiKey intentionally NOT loaded from server (already masked)
  }, [settings]);

  const currentProvider = providers.find((p) => p.id === providerId);
  const modelIds = currentProvider?.models.map((m) => m.id) ?? [];

  useEffect(() => {
    if (modelIds.length > 0 && !modelIds.includes(modelId)) {
      setModelId(modelIds[0] ?? "");
    }
  }, [providerId, modelIds, modelId]);

  async function save() {
    setSaving(true);
    setSaved(null);
    try {
      // 只有用户输入了新内容才发 apiKey;否则不发,服务端保留旧值
      const patch: Partial<SettingsPublic> = {
        provider: providerId,
        modelId,
        thinkingLevel,
        cwd,
        personaName,
        baseUrl: baseUrl || undefined,
      };
      if (apiKey) patch.apiKey = apiKey;
      await saveSettings(patch);
      setSaved("ok");
      setApiKey("");
      setTimeout(() => setSaved(null), 1500);
    } catch {
      setSaved("err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <h1 className="font-serif text-2xl" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
          设置
        </h1>
        <p className="sansheng-text-mute mt-1" style={{ fontSize: 13 }}>
          Sansheng 的工作参数 · 修改后下次会话生效
        </p>
      </div>

      <Section title="模型">
        <Row label="Provider">
          <select
            className="sansheng-input"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            style={selectStyle}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.models.length} models)
              </option>
            ))}
          </select>
        </Row>
        <Row label="Model">
          <select
            className="sansheng-input"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            style={selectStyle}
          >
            {currentProvider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.contextWindow ? `· ${m.contextWindow}` : ""}
                {m.reasoning ? " · 思考" : ""}
              </option>
            ))}
          </select>
        </Row>
        <Row label="思考">
          <select
            className="sansheng-input"
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as any)}
            style={selectStyle}
          >
            <option value="off">off · 不思考</option>
            <option value="minimal">minimal · 极少</option>
            <option value="low">low · 浅</option>
            <option value="medium">medium · 中</option>
            <option value="high">high · 深</option>
          </select>
        </Row>
        <Row label="Base URL">
          <input
            type="text"
            className="sansheng-input"
            placeholder="(可选)自定义 gateway / proxy"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={inputStyle}
          />
        </Row>
      </Section>

      <Section title="API Key">
        <Row label="Key">
          <input
            type="password"
            className="sansheng-input"
            placeholder={settings?.hasApiKey ? "(已保存,留空保持不变)" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={inputStyle}
            autoComplete="off"
          />
        </Row>
        <p className="sansheng-text-mute" style={{ fontSize: 11 }}>
          本机保存于 <code>~/.sansheng/settings.json</code>(M1 明文,M2 改 AES-256-GCM 加密)。
        </p>
      </Section>

      <Section title="工作环境">
        <Row label="显示名">
          <input
            type="text"
            className="sansheng-input"
            value={personaName}
            onChange={(e) => setPersonaName(e.target.value)}
            style={inputStyle}
          />
        </Row>
        <Row label="工作目录">
          <input
            type="text"
            className="sansheng-input"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={inputStyle}
          />
        </Row>
        <p className="sansheng-text-mute" style={{ fontSize: 11 }}>
          Sansheng 跑命令/读文件的默认目录。
        </p>
      </Section>

      <div className="flex items-center gap-3">
        <button
          className="sansheng-button-primary"
          onClick={save}
          disabled={saving || !providerId || !modelId}
          style={{ padding: "8px 16px" }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {saved === "ok" && (
          <span className="sansheng-text-jade" style={{ fontSize: 12 }}>
            ✓ 已保存,下次会话生效
          </span>
        )}
        {saved === "err" && (
          <span className="sansheng-text-cinnabar" style={{ fontSize: 12 }}>
            ✗ 保存失败
          </span>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sansheng-card-elevated p-4">
      <h2 className="font-serif mb-3" style={{ color: "var(--bone)", fontSize: 14, letterSpacing: ".04em" }}>
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[100px_1fr] items-center gap-3">
      <span className="sansheng-text-mute" style={{ fontSize: 12 }}>
        {label}
      </span>
      <div>{children}</div>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--ink-1)",
  border: "1px solid var(--ink-3)",
  color: "var(--bone)",
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 13,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};