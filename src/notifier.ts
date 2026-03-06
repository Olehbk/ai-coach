import nodemailer from "nodemailer";
import type { WeeklyPlan } from "./agent.js";

// ---------------------------------------------------------------------------
// Transport — works with any standard SMTP provider
//
// Required env vars:
//   SMTP_HOST   e.g. smtp.gmail.com | smtp.office365.com | mail.yourdomain.com
//   SMTP_PORT   587 (STARTTLS, recommended) or 465 (SSL)
//   SMTP_USER   your login address
//   SMTP_PASS   your password / app-specific password
//   EMAIL_TO    recipient address (can be same as SMTP_USER)
//
// Provider quick-reference:
//   Gmail      → host: smtp.gmail.com, port: 587
//                pass: 16-char App Password (NOT your login password)
//                Generate one at: Google Account → Security → App Passwords
//   Outlook    → host: smtp.office365.com, port: 587
//   iCloud     → host: smtp.mail.me.com, port: 587
//   Custom     → whatever your mail server exposes
// ---------------------------------------------------------------------------

function createTransport() {
  const host = process.env["SMTP_HOST"];
  const port = parseInt(process.env["SMTP_PORT"] ?? "587", 10);
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  if (!host || !user || !pass) {
    throw new Error(
      "Missing SMTP config. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file."
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for SSL (465), false for STARTTLS (587)
    auth: { user, pass },
  });
}

// ---------------------------------------------------------------------------
// HTML email renderer
// ---------------------------------------------------------------------------

function renderPlanEmail(plan: WeeklyPlan, analysis: string): string {
  const typeColors: Record<string, string> = {
    strength: "#4f46e5",
    cardio:   "#16a34a",
    mobility: "#ea580c",
    rest:     "#64748b",
  };

  const dayRows = plan.days
    .map((day) => {
      const color = typeColors[day.type] ?? "#64748b";
      const exercises =
        day.exercises.length > 0
          ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">
              <tr style="background:#f1f5f9;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">
                <td style="padding:4px 8px">Exercise</td>
                <td style="padding:4px 8px;width:50px;text-align:center">Sets</td>
                <td style="padding:4px 8px;width:60px;text-align:center">Reps</td>
                <td style="padding:4px 8px;width:100px">Target</td>
              </tr>
              ${day.exercises
                .map(
                  (ex) => `
                <tr style="border-top:1px solid #e2e8f0;font-size:13px">
                  <td style="padding:6px 8px">
                    <strong>${ex.name}</strong>
                    ${ex.notes ? `<br/><span style="color:#94a3b8;font-size:11px">${ex.notes}</span>` : ""}
                  </td>
                  <td style="padding:6px 8px;text-align:center">${ex.sets}</td>
                  <td style="padding:6px 8px;text-align:center">${ex.reps}</td>
                  <td style="padding:6px 8px;color:#64748b">${ex.targetWeight ?? "—"}</td>
                </tr>`
                )
                .join("")}
            </table>`
          : `<p style="color:#94a3b8;font-size:13px;margin:8px 0 0">Rest & recover</p>`;

      return `
        <div style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
          <div style="padding:10px 14px;background:#f8fafc;display:flex;align-items:center;gap:12px">
            <strong style="font-size:15px;min-width:40px">${day.day}</strong>
            <span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;background:${color}22;color:${color}">${day.type}</span>
            <span style="font-size:13px;color:#475569">${day.focus}</span>
          </div>
          <div style="padding:4px 14px 14px">${exercises}</div>
        </div>`;
    })
    .join("");

  const adjustmentsList =
    plan.adjustments.length > 0
      ? `<ul style="padding-left:20px;margin:8px 0 0;font-size:14px;color:#475569">
          ${plan.adjustments.map((a) => `<li style="margin-bottom:4px">${a}</li>`).join("")}
         </ul>`
      : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;color:#fff">
      <p style="margin:0 0 4px;font-size:13px;opacity:0.8;text-transform:uppercase;letter-spacing:0.1em">Weekly Training Plan</p>
      <h1 style="margin:0;font-size:24px;font-weight:700">Week of ${plan.weekOf}</h1>
      ${plan.weeklyGoal ? `<p style="margin:10px 0 0;font-size:14px;opacity:0.9;border-top:1px solid rgba(255,255,255,0.2);padding-top:10px">Goal: ${plan.weeklyGoal}</p>` : ""}
    </div>

    <div style="padding:24px 32px">

      <!-- Performance analysis -->
      ${
        analysis || plan.summary
          ? `<div style="background:#f0f4ff;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:20px">
               <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#4f46e5">Last week's performance</p>
               <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.6">${analysis || plan.summary}</p>
               ${adjustmentsList ? `<p style="margin:10px 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#4f46e5">Adjustments this week</p>${adjustmentsList}` : ""}
             </div>`
          : ""
      }

      <!-- Day-by-day plan -->
      <h2 style="font-size:16px;font-weight:700;margin:0 0 14px;color:#1e293b">Your week</h2>
      ${dayRows}

    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center">
      <p style="margin:0;font-size:12px;color:#94a3b8">
        Generated by your AI Workout Coach &nbsp;·&nbsp;
        Log your workouts at <a href="http://localhost:3000" style="color:#4f46e5">localhost:3000</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text fallback
// ---------------------------------------------------------------------------

function renderPlanText(plan: WeeklyPlan, analysis: string): string {
  const lines: string[] = [
    `WEEKLY TRAINING PLAN — Week of ${plan.weekOf}`,
    `Goal: ${plan.weeklyGoal}`,
    "",
  ];

  if (analysis || plan.summary) {
    lines.push("LAST WEEK'S PERFORMANCE");
    lines.push(analysis || plan.summary);
    if (plan.adjustments.length > 0) {
      lines.push("Adjustments:");
      plan.adjustments.forEach((a) => lines.push(`  → ${a}`));
    }
    lines.push("");
  }

  lines.push("YOUR WEEK");
  for (const day of plan.days) {
    lines.push(`\n${day.day} — ${day.type.toUpperCase()} — ${day.focus}`);
    if (day.exercises.length === 0) {
      lines.push("  Rest & recover");
    } else {
      for (const ex of day.exercises) {
        const target = ex.targetWeight ? ` @ ${ex.targetWeight}` : "";
        lines.push(`  • ${ex.name}  ${ex.sets}×${ex.reps}${target}`);
        if (ex.notes) lines.push(`    (${ex.notes})`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public send function
// ---------------------------------------------------------------------------

export async function sendPlanEmail(plan: WeeklyPlan, analysis: string): Promise<void> {
  const to = process.env["EMAIL_TO"] ?? process.env["SMTP_USER"] ?? "";
  if (!to) throw new Error("Missing EMAIL_TO in environment");

  const transport = createTransport();

  const subject = `Your training plan for the week of ${plan.weekOf}`;

  const info = await transport.sendMail({
    from: `"Workout Coach" <${process.env["SMTP_USER"]}>`,
    to,
    subject,
    html: renderPlanEmail(plan, analysis),
    text: renderPlanText(plan, analysis),
  });

  console.log(`[Notifier] Email sent → ${to} (messageId: ${info.messageId})`);
}

// ---------------------------------------------------------------------------
// Verify SMTP credentials without sending anything
// ---------------------------------------------------------------------------

export async function verifySmtpConnection(): Promise<void> {
  const transport = createTransport();
  await transport.verify();
}
