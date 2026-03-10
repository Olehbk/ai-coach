import cron from "node-cron";
import { runWeeklyAgentWorkflow } from "./agent.js";
import { sendPlanEmail } from "./notifier.js";
import { getLatestPlan, getProfile } from "./db.js";
import type { WeeklyPlan } from "./agent.js";

// ---------------------------------------------------------------------------
// Full workflow: analyze → generate → email
// ---------------------------------------------------------------------------

async function runSundayWorkflow(): Promise<void> {
  console.log("[Scheduler] Workflow started");

  const profile = getProfile();
  if (!profile.email_enabled) {
    console.log("[Scheduler] Email delivery disabled — skipping");
    return;
  }

  let plan: WeeklyPlan;

  try {
    plan = await runWeeklyAgentWorkflow();
    console.log("[Scheduler] Plan generated for week of", plan.weekOf);
  } catch (err) {
    console.error("[Scheduler] Agent failed:", err);
    return;
  }

  // Retrieve the persisted analysis text written alongside the plan
  const saved = getLatestPlan();
  const analysis = saved?.performance_analysis ?? "";

  if (!process.env["SMTP_HOST"] || !process.env["SMTP_USER"] || !process.env["SMTP_PASS"]) {
    console.warn(
      "[Scheduler] SMTP not configured — skipping email. " +
        "Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env to enable delivery."
    );
    return;
  }

  try {
    await sendPlanEmail(plan, analysis);
    console.log("[Scheduler] Notification sent");
  } catch (err) {
    console.error("[Scheduler] Email delivery failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Active task — kept so we can cancel and replace it
// ---------------------------------------------------------------------------

let activeTask: ReturnType<typeof cron.schedule> | null = null;

// ---------------------------------------------------------------------------
// Cron schedule
//
//   "0 8 * * 0"  →  08:00 every Sunday
//
// Priority: SCHEDULE_CRON env var → DB profile email_schedule → default
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  const profile = getProfile();
  const expression =
    process.env["SCHEDULE_CRON"] ?? profile.email_schedule ?? "0 8 * * 0";

  rescheduleTask(expression);
}

/**
 * Replace the running cron task with a new one.
 * Pass null to disable scheduling entirely.
 */
export function rescheduleTask(expression: string | null): void {
  if (activeTask) {
    activeTask.stop();
    activeTask = null;
  }

  if (!expression) {
    console.log("[Scheduler] Scheduling disabled");
    return;
  }

  if (!cron.validate(expression)) {
    console.error(`[Scheduler] Invalid cron expression: "${expression}"`);
    return;
  }

  activeTask = cron.schedule(expression, () => {
    void runSundayWorkflow();
  });

  console.log(`[Scheduler] Scheduled — cron: "${expression}"`);
}

// ---------------------------------------------------------------------------
// Manual trigger (useful from the REPL or a one-off script)
// ---------------------------------------------------------------------------

export async function triggerNow(): Promise<void> {
  await runSundayWorkflow();
}
