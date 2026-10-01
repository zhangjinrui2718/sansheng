# Sansheng + Pi Migration Bundle

**Branch:** `migration/setup-2026-10-01`
**Created:** 2026-10-01 13:36 CST
**Source:** `4b280b0` (sansheng HEAD at time of bundle)

## What's inside

```
migration-bundle/
├── pi-config-essentials/        (216K) — pi memory + extensions + config
│   ├── memory/                  MEMORY.md, SCRATCHPAD.md, daily/ — your knowledge base
│   ├── extensions/              empty-array-fix.ts, jev-check.ts — your custom extensions
│   ├── config/pi-task-models/   per-task model routing
│   ├── settings.json            UI preferences
│   └── models-store.json        model catalog
├── sansheng-snapshot.tar.gz     (271K) — full project source (174 files)
├── restore.sh                   one-shot restore script
└── README.md                    this file
```

**Total:** ~488 KB compressed.

## What was deliberately excluded

| Excluded | Why |
|---|---|
| `~/.pi/agent/auth.json` | **API keys — never commit** |
| `~/.pi/agent/install/` (325M) | Pi releases — re-install via npm |
| `~/.pi/agent/npm/` (342M) | npm global — re-install via npm |
| `~/.pi/agent/sessions/` (18M) | current runtime sessions — conflict on new machine |
| `~/.pi/agent/session-hoarder/` (208M) | archived sessions — keep on source machine only |
| `sansheng/.ghp_token` | GitHub PAT — never commit |
| `sansheng/node_modules/` | rebuild via `npm ci` |
| `sansheng/dist/` | rebuild via `npm run build` |
| `sansheng/.git/` | not part of source |

## How to restore on the new machine

### Quick path (Linux/macOS, Node 22+)

```bash
# 1. Clone the repo and check out this branch
git clone https://github.com/zhangjinrui2718/sansheng.git
cd sansheng
git checkout migration/setup-2026-10-01

# 2. Run the restore script
./migration-bundle/restore.sh

# 3. Edit your API keys (REQUIRED — placeholder created by restore.sh)
$EDITOR ~/.pi/agent/auth.json
chmod 600 ~/.pi/agent/auth.json
```

### What `restore.sh` does (in order)

1. Preflight: checks `node`, `npm`, `git`, `tar`; requires Node ≥ 22
2. Extracts `sansheng-snapshot.tar.gz` → `./sansheng/`
3. Copies `pi-config-essentials/*` → `~/.pi/agent/`
4. Writes placeholder `~/.pi/agent/auth.json` if missing (chmod 600)
5. Runs `npm ci` in the project (rebuilds `node_modules`)
6. Prints next-step checklist

### Manual path (if you prefer not to run restore.sh)

```bash
tar -xzf migration-bundle/sansheng-snapshot.tar.gz
mkdir -p ~/.pi/agent
cp -r migration-bundle/pi-config-essentials/* ~/.pi/agent/
cd sansheng && npm ci
# Then fill in auth.json manually
```

## Verify after restore

```bash
node --version                  # v22.x or newer
ls ~/.pi/agent/memory/MEMORY.md # your long-term memory intact
cd sansheng && npm run typecheck # should pass
cd sansheng && npm test         # 176/176 should pass
```

## What you still need to do manually

1. **API keys** — fill `~/.pi/agent/auth.json` (placeholder created)
2. **Git identity** — `git config --global user.name/email`
3. **SSH key for GitHub** (if you push from new machine) — `ssh-add` etc.
4. **Pi release install** (if you want the full pi CLI, not just memory+ext):
   `npm i -g @earendil-works/pi-coding-agent`
5. **Restore your old sessions** (if desired) — they stayed on the source machine
   under `~/.pi/agent/sessions/` and `session-hoarder/`. Copy via scp if needed.

## Rollback

If anything goes wrong, this is a branch — your main `master` is untouched:

```bash
git checkout master
```

## Re-creating the bundle on the source machine

The bundle contents are deterministic. To refresh from current `master`:

1. Update `sansheng-snapshot.tar.gz` with the current project tree (excluding
   `node_modules`, `dist`, `.git`, `.ghp_token`, `.env*`, `*.log`, `coverage`).
2. Refresh `pi-config-essentials/` from `~/.pi/agent/{memory,extensions,config,
   settings.json,models-store.json}` (never `auth.json`).
3. Commit on the `migration/setup-2026-10-01` branch and push.
