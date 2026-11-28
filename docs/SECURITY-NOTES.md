# Sansheng 本地安全形态与威胁模型

> 批次 4b B7(审查 §B7「Keyring/db 安全形态」)随代码同批交付。
> 本文是**约定**文档:代码里每一处 chmod / 原子写 / 凭据通道的取舍都对应下面某一条,
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
- 同一台机器上的**其他用户**(不同 uid):不能读到**密钥材料**。手段 = `.keyring` / `settings.json`
  的 `0600`。⚠️ 现状比这一句弱:数据目录不收紧(见下面「不防御」),`sansheng.db` 也没有收紧 ——
  全部会话与记忆对同机别的账号是可读的(§4 的第一条 ❌;密钥不在此列)。
- 崩溃 / 断电导致**密钥材料半写**:靠原子写(同目录 tmp + rename)。
- provider 密钥不漏给会话里 spawn 的**子进程**(内置 `bash`、角色自己仓库里的 MCP 服务、docker):
  凭据只进 SDK `ModelRuntime` 的内存,`process.env` 一个字节都不写(2026-11-28;此前经 env,
  每个子进程都继承得到明文 key)。

**现行代码里没有的两道**(旧系统有,随 `src/server/**` 删除之后没有重建):HTTP 的 Origin / Host
校验(WebSocket 那一道还在:`transport/hub.ts` 的 `isAllowedOrigin`)与工具侧沙箱 / 网络策略。
详见 §4 的 ❌ —— 这里不替它们论证。

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
- **启动服务的那个 shell 自己的环境**:服务进程继承它,`bash` 工具的子进程又继承服务进程
  (`getShellEnv()` = `{...process.env, PATH}`)—— 你在 shell 配置里 `export` 的任何密钥,角色跑命令时
  照样读得到。平台管的是「自己不往环境里写 provider 的 key」,管不了启动它的终端。
  ⚠️ 想确认「key 在不在子进程的环境里」只能**从子进程里面数**;`ps eww` 读的是进程 exec 那一刻的环境,
  运行期写进去的它看不见(2026-11-28 踩过)。

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

> ⚠️ **2026-11-28 按现行代码逐行重核**(起因:provider 凭据不再经 env)。在此之前这张表写的全是
> 旧系统(`src/server/**`,批次 15 已整体删除)的位置,**其中三条保护在现行代码里并不存在** ——
> 表格却还写着「有」。下表只写**能 `grep` 到**的东西;标 ❌ 的是缺口,不是「以后再说」。

| 措施 | 实现位置 | 测试 |
|---|---|---|
| `.keyring` → `0600`(新建即带 mode;读到历史遗留的宽权限当场收紧) | `src/platform/infra/keyring.ts` `tightenKeyringPermissions()` | **没有专测**(旧的 `tests/storage/file-permissions.test.ts` 已随旧系统删除) |
| `settings.json` → `0600` + 原子写 | `src/platform/infra/settings.ts` `writeJsonAtomic()` | **没有专测** |
| keyring rotate 原子化(tmp + rename) | 同上 `Keyring.rotate()` | **没有专测** |
| MCP secret 存储 → `0600` + 落盘字节里没有明文 | `src/platform/mcp/secrets.ts` | `tests/platform/mcp-config.test.ts` |
| **API key 不进 `process.env`** | `src/platform/runtime/agentRuntime/pi/providers.ts` `platformModelRuntime()` / `armRuntimeApiKey()`(key 只进 SDK `ModelRuntime` 的内存) | `tests/platform/provider-key-channel.test.ts`(含「`src/` 里没有往 `process.env` 赋值」的哨兵);真机:角色在 `bash` 子进程里数不到 key 变量(2026-11-28,见 `AGENTS.md`「真模型复核」) |
| 重置不碰 `.keyring` / `settings.json` | `src/platform/host/reset.ts`(重置 = 清平台表的行,**不删任何文件**) | `tests/platform/reset.test.ts` |
| WebSocket 只放行本机 Origin(无 Origin 的客户端放行) | `src/platform/transport/hub.ts` `isAllowedOrigin()` | **没有专测** |
| ❌ `sansheng.db` / `-wal` / `-shm` → `0600` | **现行代码里没有**(旧的 `tightenDbFilePermissions()` 随旧系统删除)。2026-11-28 实测:库文件 `0644`、数据目录 `0755` —— 同机别的账号读得到全部会话与记忆(密钥不在此列:它在 `.keyring` / `settings.json` 里,都是 `0600`) | — |
| ❌ HTTP 的 Origin / Host 校验 | **现行代码里没有**(只有 WebSocket 那一道);HTTP 缺省只绑 `127.0.0.1`(`src/cli/index.ts`) | — |
| ❌ 工具沙箱 / 网络策略 | **没有**。内置 `bash` 以用户账号权限运行:读得到工作区、连得了网、看得到用户 shell 的 env。2026-11-28 起**子进程不再继承 provider 密钥**(见上);角色自己仓库里的 MCP 服务同样不是沙箱(用户裁决「不需要我放行」) | — |

## 5. 验证约定

任何涉及本文件的改动,验证方式固定为:

1. **绝不读写真实 `~/.sansheng`**。用 `SANSHENG_DATA=$(mktemp -d)` 起临时实例,
   或在 vitest 里用 `mkdtempSync(join(tmpdir(), ...))`。
2. 权限类断言用 `statSync(path).mode & 0o777`(本组测试全部如此)。
3. smoke 走 271xx 端口;**用户的生产 server 可能在 2718 运行,不要碰**。
