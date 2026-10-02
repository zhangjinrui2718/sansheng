# Sansheng 本地安全形态与威胁模型

> 批次 4b B7(审查 §B7「Keyring/db 安全形态」)随代码同批交付。
> 本文是**约定**文档:代码里每一处 chmod / 原子写 / env 同步的取舍都对应下面某一条,
> 改动前先读这里,改完记得回来改这里。
>
> 适用范围:单用户、本机常驻的 Node 服务,数据目录默认 `~/.sansheng/`。

---

## 1. 资产

| 资产 | 位置 | 敏感度 |
|---|---|---|
| 全部会话 / 记忆 / blackboard | `sansheng.db`(+`-wal`/`-shm`) | 高(私人内容) |
| provider API Key(密文) | `settings.json` | 高 |
| masterKey(**明文 base64**) | `.keyring` | 最高(解开上面那把) |
| Pi 会话 / harness | `pi/`、`harness/` | 中(可含代码与提示词) |
| 预算 / 用量累计 | `settings.json` 的 `monthlySpentUsd` 等 | 低 |

## 2. 防御目标与非目标

**防御**
- 同一台机器上的**其他用户**(不同 uid):不能读到上面的任何一项。
  手段 = 文件权限 `0600` + 数据目录 `0700` 语义。
- 崩溃 / 断电导致**密钥材料半写**:靠原子写(同目录 tmp + rename)。
- 本机其它用户从网页发起的 CSRF:批次 2 的 Origin/Host 校验(见 `src/server/http/security.ts`),
  以及工具侧 sandbox / netPolicy(见 `src/server/tools/sandbox.ts` / `netSandbox.ts`)。
  **本文件不重复论证这两块。**

**不防御(明说,免得误以为有保护)**
- `root` / `sudo` —— 任何用户态措施都无效。
- **同一用户下的其它进程**:能 `ptrace`、能读 `/proc/<pid>/environ`、本来就能读你的家目录。
  换句话说「同机恶意程序」不在威胁模型内;真正的边界是**用户账号**。
- 内存 / swap / 崩溃转储里的明文 apiKey:`load()` 会把 apiKey 解密到内存明文
  供 kernel / UI 读取(设计如此),进程崩溃转储可能带出去。
- `.keyring` 里的 masterKey 是**明文**(base64,不是密文)。所谓「加密」只防
  「随手 `cat settings.json` 瞄一眼」这一档,**不防任何能读到 `.keyring` 文件的人**。
  真正的保护是那个文件的 `0600`。接 macOS Keychain / 平台凭据库属于后续项,
  在那之前请不要把 `~/.sansheng` 放到多人共享或会自动同步的目录里。
- 目录级保护:本项目**不**主动 chmod `~/.sansheng` 目录本身(用户可能自己放了
  其它东西,默默改它的权限位是越界)。只管自己创建的文件的权限位。

## 3. TOCTOU 窗口清单

「检查后使用」在单机单用户场景下不会成为可利用的攻击面,但仍需知道它们在哪:

| 位置 | 窗口 | 处置 |
|---|---|---|
| `Keyring` 构造器 `existsSync(filePath)` → `readFileSync` | 两次系统调用之间文件可能被换掉 | 单用户本地;且换掉也只会读到别的合法 keyring JSON,解析失败会 throw 而不是静默用错 key |
| `Keyring` 构造器 `readFileSync` → `chmodSync(0600)` | 文件在被收紧之前是 0644 | **已知残留窗口**:只有「历史遗留 0644 且进程尚未重启过」这一形态存在;首次以新版本启动即收紧(专测守护) |
| `Storage` `openDatabaseFile`:建连接 → `chmodSync(db/wal/shm)` | 同上 | 同上,单用户本地不构成提权路径 |
| `http.ts /api/reset`:`existsSync` → `rmSync` | 期间可能有别的进程重建同名文件 | 单实例由 pid 文件 + 端口占用约束;reset 只删 dataDir 内的固定路径,不吃任何请求参数 |
| `SettingsStore.save` 的 tmp 文件 | tmp 名含 pid + 随机串,同目录 | 名字不可预测 + `0600`;rename 原子,读者不会看到半截 JSON |

**为什么不做「目录级 0700 兜底」**:能防住上面所有窗口,代价是默默改动用户目录的
权限位(可能与用户的其它数据、备份、同步工具冲突)。当前判断是文件级 `0600`
已经覆盖本项目真正关心的威胁(其它 uid 读不到),目录级留给显式的用户动作。

## 4. 现状清单(与代码一一对应)

| 措施 | 实现位置 | 测试 |
|---|---|---|
| `sansheng.db` / `-wal` / `-shm` → `0600` | `src/server/storage/db.ts` `tightenDbFilePermissions()` | `tests/storage/file-permissions.test.ts` |
| `.keyring` → `0600`(含历史遗留收紧) | `src/server/storage/keyring.ts` `tightenKeyringPermissions()` | 同上 |
| `settings.json` → `0600` + 原子写 | `src/server/settings/store.ts` `writeJsonAtomic()` | `tests/server/settings-atomic.test.ts` |
| keyring rotate 原子化(tmp + rename) | 同上 `Keyring.rotate()` | 同上(`tests/storage/file-permissions.test.ts`) |
| API key 不进 `process.env`(只有建 Pi session 前同步一次 active provider) | `src/server/providers/registry.ts` `syncActiveProviderApiKeyEnv()` | `tests/server/registry-model.test.ts` |
| `/api/reset` 不删 `.keyring` / `settings.json`(不制造密钥丢失链) | `src/server/http.ts` | `tests/server/data-reset.test.ts` |
| HTTP Origin/Host 校验 | `src/server/http/security.ts`(批次 2) | `tests/server/http/security.test.ts` |
| 工具 sandbox / net policy | `src/server/tools/sandbox.ts` `netSandbox.ts`(批次 2) | `tests/tools/*` |

## 5. 验证约定

任何涉及本文件的改动,验证方式固定为:

1. **绝不读写真实 `~/.sansheng`**。用 `SANSHENG_DATA=$(mktemp -d)` 起临时实例,
   或在 vitest 里用 `mkdtempSync(join(tmpdir(), ...))`。
2. 权限类断言用 `statSync(path).mode & 0o777`(本组测试全部如此)。
3. smoke 走 271xx 端口;**用户的生产 server 可能在 2718 运行,不要碰**。
