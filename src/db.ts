import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "coach.db");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: number;
  name: string;
  fitness_level: "beginner" | "intermediate" | "advanced";
  goals: string; // JSON array of strings
  equipment: string; // JSON array of strings
  injuries: string; // plain text notes
  days_per_week: number;
  custom_plan_instructions: string; // extra instructions always applied when generating plans
  email_schedule: string; // cron expression for weekly email delivery
  email_enabled: number; // 0 = off, 1 = on
  created_at: string;
  updated_at: string;
}

export interface WorkoutLog {
  id: number;
  session_date: string; // ISO date YYYY-MM-DD
  day_of_week: string;
  planned_exercises: string; // JSON - from the weekly plan
  actual_exercises: string; // JSON - what was actually done
  rpe: number; // 1-10 rate of perceived exertion
  duration_minutes: number;
  notes: string;
  created_at: string;
}

export interface Exercise {
  name: string;
  sets: number;
  reps: string; // e.g. "8-10" or "AMRAP"
  weight?: string; // e.g. "80kg", "70% 1RM"
  rpe?: number;
  notes?: string;
}

export interface WeeklyPlan {
  id: number;
  week_start: string; // ISO date of Monday
  plan: string; // full JSON plan
  performance_analysis: string; // Claude's written analysis
  created_at: string;
}

export interface ChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface DbChatMessage {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  import("fs").then((fs) => {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
  return _db;
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL DEFAULT 'Athlete',
      fitness_level   TEXT    NOT NULL DEFAULT 'intermediate'
                              CHECK(fitness_level IN ('beginner','intermediate','advanced')),
      goals           TEXT    NOT NULL DEFAULT '[]',
      equipment       TEXT    NOT NULL DEFAULT '[]',
      injuries        TEXT    NOT NULL DEFAULT '',
      days_per_week   INTEGER NOT NULL DEFAULT 4,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workout_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date        TEXT    NOT NULL,
      day_of_week         TEXT    NOT NULL,
      planned_exercises   TEXT    NOT NULL DEFAULT '[]',
      actual_exercises    TEXT    NOT NULL DEFAULT '[]',
      rpe                 INTEGER NOT NULL DEFAULT 0 CHECK(rpe BETWEEN 0 AND 10),
      duration_minutes    INTEGER NOT NULL DEFAULT 0,
      notes               TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_plans (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start            TEXT    NOT NULL UNIQUE,
      plan                  TEXT    NOT NULL,
      performance_analysis  TEXT    NOT NULL DEFAULT '',
      created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT 'New conversation',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
      content    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add new columns to existing installs
  addColumnIfMissing(db, "user_profile", "custom_plan_instructions", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "user_profile", "email_schedule", "TEXT NOT NULL DEFAULT '0 8 * * 0'");
  addColumnIfMissing(db, "user_profile", "email_enabled", "INTEGER NOT NULL DEFAULT 1");

  // Seed a default profile if none exists
  const count = (
    db.prepare("SELECT COUNT(*) as c FROM user_profile").get() as {
      c: number;
    }
  ).c;

  if (count === 0) {
    db.prepare(`
      INSERT INTO user_profile (name, fitness_level, goals, equipment, injuries, days_per_week)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "Athlete",
      "intermediate",
      JSON.stringify(["Build muscle", "Improve endurance"]),
      JSON.stringify(["Barbell", "Dumbbells", "Pull-up bar", "Bench"]),
      "",
      4
    );
  }
}

// ---------------------------------------------------------------------------
// Profile queries
// ---------------------------------------------------------------------------

export function getProfile(): UserProfile {
  const db = getDb();
  return db.prepare("SELECT * FROM user_profile LIMIT 1").get() as UserProfile;
}

export function updateProfile(
  fields: Partial<
    Omit<UserProfile, "id" | "created_at" | "updated_at">
  >
): UserProfile {
  const db = getDb();

  const allowed = [
    "name",
    "fitness_level",
    "goals",
    "equipment",
    "injuries",
    "days_per_week",
    "custom_plan_instructions",
    "email_schedule",
    "email_enabled",
  ] as const;

  const updates: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (key in fields) {
      updates.push(`${key} = ?`);
      const val = fields[key];
      values.push(
        Array.isArray(val) ? JSON.stringify(val) : val
      );
    }
  }

  if (updates.length === 0) return getProfile();

  updates.push("updated_at = datetime('now')");
  values.push((db.prepare("SELECT id FROM user_profile LIMIT 1").get() as { id: number }).id);

  db.prepare(
    `UPDATE user_profile SET ${updates.join(", ")} WHERE id = ?`
  ).run(...values);

  return getProfile();
}

// ---------------------------------------------------------------------------
// Workout log queries
// ---------------------------------------------------------------------------

export function logWorkout(entry: {
  session_date: string;
  day_of_week: string;
  planned_exercises?: Exercise[];
  actual_exercises: Exercise[];
  rpe: number;
  duration_minutes: number;
  notes?: string;
}): WorkoutLog {
  const db = getDb();

  const result = db
    .prepare(`
      INSERT INTO workout_logs
        (session_date, day_of_week, planned_exercises, actual_exercises, rpe, duration_minutes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.session_date,
      entry.day_of_week,
      JSON.stringify(entry.planned_exercises ?? []),
      JSON.stringify(entry.actual_exercises),
      entry.rpe,
      entry.duration_minutes,
      entry.notes ?? ""
    );

  return db
    .prepare("SELECT * FROM workout_logs WHERE id = ?")
    .get(result.lastInsertRowid) as WorkoutLog;
}

export function getLogsForWeek(weekStart: string): WorkoutLog[] {
  const db = getDb();
  // weekStart is Monday (ISO YYYY-MM-DD); fetch Mon–Sun
  return db
    .prepare(`
      SELECT * FROM workout_logs
      WHERE session_date >= ? AND session_date <= date(?, '+6 days')
      ORDER BY session_date ASC
    `)
    .all(weekStart, weekStart) as WorkoutLog[];
}

export function getRecentLogs(days = 7): WorkoutLog[] {
  const db = getDb();
  return db
    .prepare(`
      SELECT * FROM workout_logs
      WHERE session_date >= date('now', ? || ' days')
      ORDER BY session_date ASC
    `)
    .all(`-${days}`) as WorkoutLog[];
}

export function getLogById(id: number): WorkoutLog | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM workout_logs WHERE id = ?")
    .get(id) as WorkoutLog | undefined;
}

export function updateLog(
  id: number,
  fields: Partial<
    Pick<WorkoutLog, "actual_exercises" | "rpe" | "duration_minutes" | "notes">
  >
): WorkoutLog | undefined {
  const db = getDb();
  const allowed = ["actual_exercises", "rpe", "duration_minutes", "notes"] as const;
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (key in fields) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return getLogById(id);

  values.push(id);
  db.prepare(`UPDATE workout_logs SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getLogById(id);
}

// ---------------------------------------------------------------------------
// Weekly plan queries
// ---------------------------------------------------------------------------

export function savePlan(weekStart: string, plan: object, analysis: string): WeeklyPlan {
  const db = getDb();

  db.prepare(`
    INSERT INTO weekly_plans (week_start, plan, performance_analysis)
    VALUES (?, ?, ?)
    ON CONFLICT(week_start) DO UPDATE SET
      plan = excluded.plan,
      performance_analysis = excluded.performance_analysis,
      created_at = datetime('now')
  `).run(weekStart, JSON.stringify(plan), analysis);

  return db
    .prepare("SELECT * FROM weekly_plans WHERE week_start = ?")
    .get(weekStart) as WeeklyPlan;
}

export function getPlan(weekStart: string): WeeklyPlan | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM weekly_plans WHERE week_start = ?")
    .get(weekStart) as WeeklyPlan | undefined;
}

export function getLatestPlan(): WeeklyPlan | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM weekly_plans ORDER BY week_start DESC LIMIT 1")
    .get() as WeeklyPlan | undefined;
}

// ---------------------------------------------------------------------------
// Helper: get Monday of the current week (ISO YYYY-MM-DD)
// ---------------------------------------------------------------------------

export function getCurrentWeekStart(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

export function getPreviousWeekStart(): string {
  const thisMonday = getCurrentWeekStart();
  const prev = new Date(thisMonday);
  prev.setDate(prev.getDate() - 7);
  return prev.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Chat session queries
// ---------------------------------------------------------------------------

export function createChatSession(title = "New conversation"): ChatSession {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO chat_sessions (title) VALUES (?)")
    .run(title);
  return db
    .prepare("SELECT * FROM chat_sessions WHERE id = ?")
    .get(result.lastInsertRowid) as ChatSession;
}

export function listChatSessions(): ChatSession[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC")
    .all() as ChatSession[];
}

export function getChatSession(id: number): ChatSession | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM chat_sessions WHERE id = ?")
    .get(id) as ChatSession | undefined;
}

export function updateChatSessionTitle(id: number, title: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, id);
}

export function touchChatSession(id: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deleteChatSession(id: number): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Chat message queries
// ---------------------------------------------------------------------------

export function addChatMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)"
  ).run(sessionId, role, content);
  touchChatSession(sessionId);
}

export function getChatMessages(sessionId: number): DbChatMessage[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
    )
    .all(sessionId) as DbChatMessage[];
}

/**
 * Returns recent user messages from all chat sessions as a plain-text block
 * so the plan agent can reference stated preferences and constraints.
 */
export function getRecentChatContent(limitMessages = 40): string {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT cm.content, cm.created_at
       FROM chat_messages cm
       WHERE cm.role = 'user'
       ORDER BY cm.created_at DESC
       LIMIT ?`
    )
    .all(limitMessages) as { content: string; created_at: string }[];

  if (rows.length === 0) return "No chat history available.";

  return rows
    .reverse()
    .map((r) => `[${r.created_at.slice(0, 10)}] ${r.content}`)
    .join("\n");
}
