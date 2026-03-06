import cron from "node-cron";
import { runWeeklyAgentWorkflow } from "./agent.js";
import { sendPlanEmail } from "./notifier.js";
import { getLatestPlan } from "./db.js";
import type { WeeklyPlan } from "./agent.js";

// ---------------------------------------------------------------------------
// Full Sunday workflow: analyze → generate → email
// ---------------------------------------------------------------------------

async function runSundayWorkflow(): Promise<void> {
  console.log("[Scheduler] Sunday workflow started");

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
// Cron schedule
//
//   "0 8 * * 0"  →  08:00 every Sunday
//
// Override via SCHEDULE_CRON env var for testing, e.g.:
//   SCHEDULE_CRON="* * * * *"  (every minute — dev only)
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  const expression = process.env["SCHEDULE_CRON"] ?? "0 8 * * 0";

  if (!cron.validate(expression)) {
    console.error(`[Scheduler] Invalid cron expression: "${expression}"`);
    return;
  }

  cron.schedule(expression, () => {
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
