import express, { type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  getProfile,
  updateProfile,
  logWorkout,
  getRecentLogs,
  getLogsForWeek,
  updateLog,
  getLatestPlan,
  getPlan,
  getCurrentWeekStart,
  createChatSession,
  listChatSessions,
  getChatSession,
  getChatMessages,
  addChatMessage,
  updateChatSessionTitle,
  deleteChatSession,
  type Exercise,
  type DbChatMessage,
} from "./db.js";
import { generatePlanNow } from "./agent.js";
import { sendPlanEmail, verifySmtpConnection } from "./notifier.js";
import { runChatTurn, type ChatMessage } from "./chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, "..", "src", "public")));

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  /** GET /api/profile — get current profile */
  app.get("/api/profile", (_req: Request, res: Response) => {
    const profile = getProfile();
    res.json({
      ...profile,
      goals: JSON.parse(profile.goals as string),
      equipment: JSON.parse(profile.equipment as string),
    });
  });

  /** PUT /api/profile — update profile */
  app.put("/api/profile", (req: Request, res: Response) => {
    const { name, fitness_level, goals, equipment, injuries, days_per_week } =
      req.body as {
        name?: string;
        fitness_level?: "beginner" | "intermediate" | "advanced";
        goals?: string[];
        equipment?: string[];
        injuries?: string;
        days_per_week?: number;
      };

    const updated = updateProfile({
      ...(name !== undefined && { name }),
      ...(fitness_level !== undefined && { fitness_level }),
      ...(goals !== undefined && { goals: JSON.stringify(goals) }),
      ...(equipment !== undefined && { equipment: JSON.stringify(equipment) }),
      ...(injuries !== undefined && { injuries }),
      ...(days_per_week !== undefined && { days_per_week }),
    });

    res.json({
      ...updated,
      goals: JSON.parse(updated.goals as string),
      equipment: JSON.parse(updated.equipment as string),
    });
  });

  // -------------------------------------------------------------------------
  // Workout logs
  // -------------------------------------------------------------------------

  /** GET /api/logs?days=7 — get recent logs */
  app.get("/api/logs", (req: Request, res: Response) => {
    const days = parseInt((req.query["days"] as string) ?? "7", 10);
    const logs = getRecentLogs(isNaN(days) ? 7 : days);
    res.json(
      logs.map((l) => ({
        ...l,
        planned_exercises: JSON.parse(l.planned_exercises as string),
        actual_exercises: JSON.parse(l.actual_exercises as string),
      }))
    );
  });

  /** GET /api/logs/week/:date — logs for a specific week (YYYY-MM-DD = Monday) */
  app.get("/api/logs/week/:date", (req: Request, res: Response) => {
    const logs = getLogsForWeek(String(req.params["date"] ?? ""));
    res.json(
      logs.map((l) => ({
        ...l,
        planned_exercises: JSON.parse(l.planned_exercises as string),
        actual_exercises: JSON.parse(l.actual_exercises as string),
      }))
    );
  });

  /** POST /api/logs — log a completed workout session */
  app.post("/api/logs", (req: Request, res: Response) => {
    const {
      session_date,
      day_of_week,
      actual_exercises,
      rpe,
      duration_minutes,
      notes,
      planned_exercises,
    } = req.body as {
      session_date: string;
      day_of_week: string;
      actual_exercises: Exercise[];
      rpe: number;
      duration_minutes: number;
      notes?: string;
      planned_exercises?: Exercise[];
    };

    if (!session_date || !day_of_week || !actual_exercises || rpe == null || !duration_minutes) {
      res.status(400).json({ error: "Missing required fields: session_date, day_of_week, actual_exercises, rpe, duration_minutes" });
      return;
    }

    const log = logWorkout({
      session_date,
      day_of_week,
      actual_exercises,
      planned_exercises: planned_exercises ?? [],
      rpe: Number(rpe),
      duration_minutes: Number(duration_minutes),
      notes,
    });

    res.status(201).json({
      ...log,
      planned_exercises: JSON.parse(log.planned_exercises as string),
      actual_exercises: JSON.parse(log.actual_exercises as string),
    });
  });

  /** PATCH /api/logs/:id — update an existing log */
  app.patch("/api/logs/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params["id"] ?? ""), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid log id" });
      return;
    }

    const { actual_exercises, rpe, duration_minutes, notes } = req.body as {
      actual_exercises?: Exercise[];
      rpe?: number;
      duration_minutes?: number;
      notes?: string;
    };

    const updated = updateLog(id, {
      ...(actual_exercises !== undefined && {
        actual_exercises: JSON.stringify(actual_exercises),
      }),
      ...(rpe !== undefined && { rpe }),
      ...(duration_minutes !== undefined && { duration_minutes }),
      ...(notes !== undefined && { notes }),
    });

    if (!updated) {
      res.status(404).json({ error: "Log not found" });
      return;
    }

    res.json({
      ...updated,
      planned_exercises: JSON.parse(updated.planned_exercises as string),
      actual_exercises: JSON.parse(updated.actual_exercises as string),
    });
  });

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  /** GET /api/plan/current — current week's plan */
  app.get("/api/plan/current", (_req: Request, res: Response) => {
    const plan = getPlan(getCurrentWeekStart());
    if (!plan) {
      res.status(404).json({ error: "No plan for current week. Trigger /api/plan/generate to create one." });
      return;
    }
    res.json({ ...plan, plan: JSON.parse(plan.plan as string) });
  });

  /** GET /api/plan/latest — most recently generated plan */
  app.get("/api/plan/latest", (_req: Request, res: Response) => {
    const plan = getLatestPlan();
    if (!plan) {
      res.status(404).json({ error: "No plans generated yet." });
      return;
    }
    res.json({ ...plan, plan: JSON.parse(plan.plan as string) });
  });

  /** POST /api/plan/generate — manually trigger the agent to generate a plan now */
  app.post("/api/plan/generate", async (_req: Request, res: Response) => {
    try {
      console.log("[Server] Manual plan generation triggered");
      const plan = await generatePlanNow();
      res.json({ success: true, plan });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** POST /api/notify/test — send a test email using the latest saved plan */
  app.post("/api/notify/test", async (_req: Request, res: Response) => {
    const saved = getLatestPlan();
    if (!saved) {
      res.status(404).json({ error: "No plan saved yet. Generate one first via POST /api/plan/generate." });
      return;
    }
    try {
      const plan = JSON.parse(saved.plan as string) as Parameters<typeof sendPlanEmail>[0];
      await sendPlanEmail(plan, saved.performance_analysis as string);
      res.json({ success: true, message: `Test email sent to ${process.env["EMAIL_TO"] ?? process.env["SMTP_USER"]}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** GET /api/notify/verify — verify SMTP credentials are working */
  app.get("/api/notify/verify", async (_req: Request, res: Response) => {
    try {
      await verifySmtpConnection();
      res.json({ success: true, message: "SMTP connection verified successfully." });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // Chat sessions
  // -------------------------------------------------------------------------

  /** GET /api/chat/sessions — list all sessions newest first */
  app.get("/api/chat/sessions", (_req: Request, res: Response) => {
    res.json(listChatSessions());
  });

  /** POST /api/chat/sessions — create a new empty session */
  app.post("/api/chat/sessions", (_req: Request, res: Response) => {
    const session = createChatSession();
    res.status(201).json(session);
  });

  /** GET /api/chat/sessions/:id — get messages for a session */
  app.get("/api/chat/sessions/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params["id"]), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const session = getChatSession(id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    const messages: DbChatMessage[] = getChatMessages(id);
    res.json({ session, messages });
  });

  /** PATCH /api/chat/sessions/:id — rename a session */
  app.patch("/api/chat/sessions/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params["id"]), 10);
    const { title } = req.body as { title?: string };
    if (isNaN(id) || !title) { res.status(400).json({ error: "Invalid id or missing title" }); return; }
    updateChatSessionTitle(id, title.trim());
    res.json(getChatSession(id));
  });

  /** DELETE /api/chat/sessions/:id — delete a session and all its messages */
  app.delete("/api/chat/sessions/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params["id"]), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    deleteChatSession(id);
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // Chat — send a message
  // -------------------------------------------------------------------------

  /**
   * POST /api/chat
   * Body: { message: string, sessionId?: number }
   *   - If sessionId is omitted, a new session is created automatically.
   * Returns: { reply: string, sessionId: number, sessionTitle: string }
   */
  app.post("/api/chat", async (req: Request, res: Response) => {
    const { message, sessionId: rawSessionId } = req.body as {
      message: string;
      sessionId?: number;
    };

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Missing message" });
      return;
    }

    try {
      // Resolve or create session
      let sessionId = rawSessionId ?? null;
      if (!sessionId) {
        const s = createChatSession();
        sessionId = s.id;
      } else if (!getChatSession(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Load history from DB and convert for the chat agent
      const dbMessages = getChatMessages(sessionId);
      const history: ChatMessage[] = dbMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Persist the new user message
      addChatMessage(sessionId, "user", message);

      // Run the agent
      const reply = await runChatTurn(history, message);

      // Persist the reply
      addChatMessage(sessionId, "assistant", reply);

      // Auto-title from first user message (≤55 chars)
      const session = getChatSession(sessionId)!;
      if (session.title === "New conversation" && dbMessages.length === 0) {
        const title = message.length > 55 ? message.slice(0, 52) + "…" : message;
        updateChatSessionTitle(sessionId, title);
      }

      res.json({
        reply,
        sessionId,
        sessionTitle: getChatSession(sessionId)!.title,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // Serve HTML UI at root
  // -------------------------------------------------------------------------

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "..", "src", "public", "index.html"));
  });

  return app;
}

export function startServer(port = parseInt(process.env["PORT"] ?? "3000", 10)) {
  const app = createServer();
  app.listen(port, () => {
    console.log(`[Server] Workout Coach running at http://localhost:${port}`);
  });
  return app;
}
