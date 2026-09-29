import { useEffect, useState } from "react";

interface ProfileEntry {
  key: string;
  value: string;
  confidence?: number;
  updatedAt?: number;
}

interface FragmentRow {
  id: string;
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance?: number;
  accessCount?: number;
  createdAt: number;
}

export function MemoryPage() {
  const [profile, setProfile] = useState<ProfileEntry[]>([]);
  const [fragments, setFragments] = useState<FragmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [profRes, fragRes] = await Promise.all([
          fetch("/api/profile").then((r) => r.json()),
          fetch("/api/memory/fragments").then((r) => r.json()),
        ]);
        if (cancelled) return;
        setProfile(Array.isArray(profRes?.profile) ? profRes.profile : []);
        setFragments(Array.isArray(fragRes?.fragments) ? fragRes.fragments : []);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="px-4 pb-4">
      <h2 className="sansheng-h2">User Profile</h2>
      <div className="grid gap-2">
        {profile.length === 0 ? (
          <div className="sansheng-card p-3 text-xs opacity-70">
            暂无 profile。聊天中提取到的事实/偏好会出现在这里。
          </div>
        ) : (
          profile.map((p) => (
            <div key={p.key} className="sansheng-card p-3">
              <div className="text-sm font-medium">{p.key}</div>
              <div className="text-xs opacity-80">{p.value}</div>
            </div>
          ))
        )}
      </div>

      <h2 className="sansheng-h2 mt-4">Memory Fragments</h2>
      <div className="grid gap-2">
        {error ? (
          <div className="sansheng-card p-3 text-xs opacity-70">加载失败：{error}</div>
        ) : fragments.length === 0 ? (
          <div className="sansheng-card p-3 text-xs opacity-70">
            暂无 fragment。多 agent run 后的 reflection 会写入这里。
          </div>
        ) : (
          fragments.map((f) => (
            <div key={f.id} className="sansheng-card p-3">
              <div className="text-xs opacity-60">
                {f.kind} · {new Date(f.createdAt).toLocaleString()}
              </div>
              <div className="text-sm">{f.content}</div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}