-- V1__init.sql — AI Growth 初始 schema
-- 约定：时间一律存 ISO timestamp (UTC)；"哪一天" 由 Core 按 settings/profile 中 timezone 计算。

CREATE TABLE IF NOT EXISTS system_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT,
  timezone             TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  onboarding_status    TEXT NOT NULL DEFAULT 'NOT_STARTED', -- NOT_STARTED | IN_PROGRESS | COMPLETED
  time_preferences     TEXT NOT NULL DEFAULT '{}',          -- JSON
  task_capacity        TEXT NOT NULL DEFAULT '{}',          -- JSON {defaultDailyActions, maxTotal,...}
  learning_preferences TEXT NOT NULL DEFAULT '{}',          -- JSON
  reminder_preferences TEXT NOT NULL DEFAULT '{}',          -- JSON
  constraints          TEXT NOT NULL DEFAULT '{}',           -- JSON
  notes                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);

CREATE TABLE IF NOT EXISTS directions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description  TEXT,
  domain        TEXT NOT NULL DEFAULT 'OTHER',
  origin        TEXT NOT NULL DEFAULT 'USER_CONFIRMED', -- USER_CONFIRMED | INFERRED
  confirmed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  why                   TEXT NOT NULL DEFAULT '',
  desired_outcome       TEXT NOT NULL DEFAULT '',
  success_criteria      TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  motivation            TEXT,
  start_date            TEXT,
  target_date           TEXT,
  status                TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','CONFIRMED','ACTIVE','PAUSED','COMPLETED','ABANDONED')),
  daily_time_budget_minutes INTEGER,
  acceptance_criteria   TEXT NOT NULL DEFAULT '[]',  -- JSON
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);

CREATE TABLE IF NOT EXISTS stages (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES goals(id),
  title               TEXT NOT NULL,
  objective           TEXT,
  order_index         INTEGER NOT NULL,
  planned_start_date  TEXT,
  planned_end_date    TEXT,
  status              TEXT NOT NULL DEFAULT 'PLANNED'
                      CHECK (status IN ('PLANNED','ACTIVE','COMPLETED','DELAYED','SKIPPED')),
  exit_criteria       TEXT NOT NULL DEFAULT '[]', -- JSON
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_stages_goal ON stages(goal_id);

CREATE TABLE IF NOT EXISTS daily_plans (
  id            TEXT PRIMARY KEY,
  date_key      TEXT NOT NULL,             -- YYYY-MM-DD (local tz)
  rationale     TEXT,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED')),
  created_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  UNIQUE(date_key)
);

CREATE TABLE IF NOT EXISTS actions (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('MAIN_QUEST','DAILY')),
  domain                 TEXT NOT NULL DEFAULT 'OTHER',
  title                  TEXT NOT NULL,
  description            TEXT,
  why_today              TEXT,              -- Main Quest 必填：为什么今天做
  estimated_minutes      INTEGER,
  completion_criteria    TEXT,               -- 完成标准
  evidence_requirements TEXT,               -- Evidence 要求
  verification_strategy  TEXT,               -- 验收方式
  basis                  TEXT,               -- 依据说明（必须可追溯到用户认可的 Goal/意图/约束）
  basis_goal_id          TEXT REFERENCES goals(id),
  basis_direction_id     TEXT REFERENCES directions(id),
  basis_stage_id         TEXT REFERENCES stages(id),
  plan_id                TEXT REFERENCES daily_plans(id),
  date_key               TEXT NOT NULL,      -- 属于哪个自然日
  status                 TEXT NOT NULL DEFAULT 'PLANNED'
                         CHECK (status IN ('DRAFT','PLANNED','IN_PROGRESS','COMPLETED','SKIPPED','DELAYED','PENDING_REPLAN','EXPIRED','CANCELLED')),
  skipped_reason         TEXT,
  completed_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_date ON actions(date_key);
CREATE INDEX IF NOT EXISTS idx_actions_plan ON actions(plan_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);

CREATE TABLE IF NOT EXISTS task_feedback (
  id          TEXT PRIMARY KEY,
  action_id   TEXT NOT NULL REFERENCES actions(id),
  reason      TEXT NOT NULL CHECK (reason IN
    ('NOT_INTERESTED','BAD_TIMING','TOO_HARD','TOO_EASY','ALREADY_DONE','NOT_RELEVANT','NO_TIME','OTHER')),
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_action ON task_feedback(action_id);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  action_id   TEXT REFERENCES actions(id),
  type        TEXT NOT NULL CHECK (type IN
    ('TEXT','FILE','GIT','METRIC','QUIZ','ARTIFACT','REFLECTION','MANUAL')),
  strength    TEXT NOT NULL DEFAULT 'USER_CONFIRMED' CHECK (strength IN
    ('AUTO_VERIFIED','USER_CONFIRMED','AGENT_OBSERVED','UNVERIFIED')),
  content     TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',   -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_action ON evidence(action_id);

CREATE TABLE IF NOT EXISTS assessments (
  id           TEXT PRIMARY KEY,
  action_id    TEXT REFERENCES actions(id),
  goal_id      TEXT REFERENCES goals(id),
  topic        TEXT NOT NULL,
  -- 新建评估默认 EXPOSURE（接触过），由 submit_assessment 升级
  level        TEXT NOT NULL DEFAULT 'EXPOSURE' CHECK (level IN
    ('EXPOSURE','RECALL','EXPLAIN','APPLY','REAL_WORLD_EVIDENCE')),
  method       TEXT,   -- explain | quiz | coding-challenge | practical | mini-project | real-project
  passed       INTEGER NOT NULL DEFAULT 0,
  result       TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS growth_events (
  id           TEXT PRIMARY KEY,
  date_key     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  domain       TEXT NOT NULL DEFAULT 'OTHER',
  evidence_ids TEXT NOT NULL DEFAULT '[]',  -- JSON
  goal_id      TEXT,
  stage_id     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]', -- JSON
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_growth_events_date ON growth_events(date_key);

CREATE TABLE IF NOT EXISTS life_contexts (
  id                         TEXT PRIMARY KEY,
  mode                       TEXT NOT NULL CHECK (mode IN
    ('NORMAL','BUSY','RECOVERY','TRAVEL','FOCUS','CUSTOM')),
  available_minutes_per_day  INTEGER,
  start_date                 TEXT NOT NULL,      -- date key
  expected_end_date          TEXT,               -- date key
  note                       TEXT,
  confirmed                  INTEGER NOT NULL DEFAULT 0,
  active                     INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  type                TEXT NOT NULL CHECK (type IN ('FACT','PATTERN','DECISION','CHANGE')),
  content             TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 0.5,
  evidence_refs       TEXT NOT NULL DEFAULT '[]', -- JSON evidence ids
  confirmed_by_user   INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  action_id     TEXT NOT NULL REFERENCES actions(id),
  scheduled_at  TEXT NOT NULL,             -- ISO timestamp
  status        TEXT NOT NULL DEFAULT 'SCHEDULED'
                CHECK (status IN ('SCHEDULED','SENT','CANCELLED')),
  channel       TEXT NOT NULL DEFAULT 'LOCAL_NOTIFICATION'
                CHECK (channel IN ('LOCAL_NOTIFICATION','WEB','OTHER')),
  fired_at      TEXT,
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_action ON reminders(action_id);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);

CREATE TABLE IF NOT EXISTS passport_snapshots (
  id            TEXT PRIMARY KEY,
  passport      TEXT NOT NULL,   -- JSON
  generated_at  TEXT NOT NULL,
  dirty         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,              -- PASSPORT_SYNC
  payload      TEXT NOT NULL DEFAULT '{}',-- JSON
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_versions (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  evidence_ids  TEXT NOT NULL DEFAULT '[]', -- JSON
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,   -- agent | user | daemon | system
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  before        TEXT,           -- JSON
  after         TEXT,           -- JSON
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
