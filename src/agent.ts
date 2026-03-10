import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  getProfile,
  getRecentLogs,
  getPreviousWeekStart,
  getCurrentWeekStart,
  savePlan,
  getLatestPlan,
  getRecentChatContent,
  type WorkoutLog,
  type UserProfile,
} from "./db.js";

// ---------------------------------------------------------------------------
// Plan schema (enforced via Zod on Claude's JSON output)
// ---------------------------------------------------------------------------

const ExerciseSchema = z.object({
  name: z.string(),
  sets: z.number().int().positive(),
  reps: z.string(), // e.g. "8-10", "AMRAP", "60s"
  targetWeight: z.string().optional(), // e.g. "80kg", "RPE 7", "70% 1RM"
  notes: z.string().optional(),
});

const DaySchema = z.object({
  day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  type: z.enum(["strength", "cardio", "mobility", "rest"]),
  focus: z.string(),
  exercises: z.array(ExerciseSchema),
});

export const WeeklyPlanSchema = z.object({
  weekOf: z.string(), // ISO date of Monday
  summary: z.string(), // 2-3 sentence performance recap
  adjustments: z.array(z.string()), // what changed vs last week and why
  days: z.array(DaySchema),
  weeklyGoal: z.string(),
});

export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;

// ---------------------------------------------------------------------------
// Tool definitions for the agent
// ---------------------------------------------------------------------------

const tools = [
  {
    type: "web_search_20250305",
    name: "web_search",
  } as const,
  {
    name: "get_user_profile",
    description:
      "Retrieve the athlete's profile including fitness level, goals, available equipment, injury notes, and how many days per week they train.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_last_week_logs",
    description:
      "Retrieve all workout logs from the previous 7 days. Each log contains: session date, planned exercises, actual exercises performed, RPE (rate of perceived exertion 1-10), duration in minutes, and notes.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_previous_plan",
    description:
      "Retrieve the most recently generated weekly plan so the new plan can build on it progressively.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_chat_insights",
    description:
      "Retrieve recent messages the athlete wrote to their coach in past conversations. Use this to find stated preferences, goals, complaints, or special requests (e.g. 'I want more leg work', 'skip cardio this week', 'focus on powerlifting'). Always call this before generating the plan.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "save_weekly_plan",
    description:
      "Save the generated weekly training plan to the database. Call this after finalizing the plan JSON.",
    input_schema: {
      type: "object" as const,
      properties: {
        weekStart: {
          type: "string",
          description: "ISO date string for Monday of the upcoming week (YYYY-MM-DD)",
        },
        plan: {
          type: "object",
          description: "The complete weekly plan object matching the WeeklyPlan schema",
        },
        analysis: {
          type: "string",
          description: "2-4 sentence plain-English summary of last week's performance",
        },
      },
      required: ["weekStart", "plan", "analysis"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

function executeTool(
  name: string,
  input: Record<string, unknown>
): unknown {
  switch (name) {
    case "get_user_profile": {
      const profile = getProfile();
      return {
        ...profile,
        goals: JSON.parse(profile.goals as string),
        equipment: JSON.parse(profile.equipment as string),
      };
    }

    case "get_last_week_logs": {
      const logs = getRecentLogs(7);
      return logs.map((log: WorkoutLog) => ({
        ...log,
        planned_exercises: JSON.parse(log.planned_exercises as string),
        actual_exercises: JSON.parse(log.actual_exercises as string),
      }));
    }

    case "get_previous_plan": {
      const plan = getLatestPlan();
      if (!plan) return null;
      return {
        ...plan,
        plan: JSON.parse(plan.plan as string),
      };
    }

    case "get_chat_insights": {
      return getRecentChatContent(40);
    }

    case "save_weekly_plan": {
      const { weekStart, plan, analysis } = input as {
        weekStart: string;
        plan: object;
        analysis: string;
      };
      // Validate with Zod before saving
      const parsed = WeeklyPlanSchema.safeParse(plan);
      if (!parsed.success) {
        return { error: "Plan schema validation failed", details: parsed.error.flatten() };
      }
      const saved = savePlan(weekStart, parsed.data, analysis);
      return { success: true, id: saved.id, weekStart: saved.week_start };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(overrideInstructions?: string): string {
  const nextMonday = getCurrentWeekStart();
  // Actually we want next week's Monday
  const d = new Date(nextMonday);
  d.setDate(d.getDate() + 7);
  const upcomingWeek = d.toISOString().slice(0, 10);

  const profile = getProfile();
  const customInstructions = overrideInstructions ?? profile.custom_plan_instructions ?? "";

  return `You are an expert personal trainer and sports coach AI. Your job is to synthesize every available data source — athlete profile, workout history, previous plans, stated preferences, and current training science — into the best possible weekly training plan.

Today is ${new Date().toISOString().slice(0, 10)}. The upcoming week starts on ${upcomingWeek}.

## Workflow

### Step 1 — Gather all data in parallel (one turn, multiple tool calls)
Call ALL FOUR of these tools simultaneously in your first response:
- get_user_profile — goals, fitness level, equipment, injuries, training days
- get_last_week_logs — what was actually done, RPE, duration, notes
- get_previous_plan — last plan to enable progressive overload
- get_chat_insights — explicit preferences, events, constraints the athlete has mentioned

### Step 2 — Web research (always required)
After reviewing the data, use web_search to look up current, evidence-based information relevant to THIS athlete. Always search for at least one of:
- Best practices for their specific event or goal (e.g. "Hyrox 8-week prep block", "powerlifting peak week protocol")
- Optimal progression schemes for their current training phase (e.g. "intermediate strength periodization RPE")
- Exercise substitutions or technique details for anything in their history or custom instructions
- Recovery or injury management if they have notes about pain or fatigue

Do not skip web research. Even for standard goals, look up one current best-practice reference to ensure the plan is based on up-to-date methods.

### Step 3 — Synthesize everything
Before writing the plan, mentally integrate:
- Profile: what constraints and goals bound the plan
- Logs: what actually happened last week (adherence, fatigue, performance)
- Previous plan: what changed vs what was planned, and why
- Chat insights: any explicit requests or event-specific context
- Web research: current best practices for their goal
- Custom instructions (if any): standing overrides that always apply

### Step 4 — Generate the plan
Produce a JSON object matching this exact schema:
{
  weekOf: string (ISO Monday date),
  summary: string (2-3 sentences: what the data tells you about their current state),
  adjustments: string[] (what changed vs last week and why — cite specific data),
  days: Array of {
    day: "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun",
    type: "strength"|"cardio"|"mobility"|"rest",
    focus: string (e.g. "Upper body push", "Zone 2 cardio"),
    exercises: Array of {
      name: string,
      sets: number,
      reps: string (e.g. "8-10", "AMRAP", "45s"),
      targetWeight?: string (e.g. "RPE 7", "80kg", "70% 1RM"),
      notes?: string
    }
  },
  weeklyGoal: string (one sentence priority for the week)
}

### Step 5 — Save
Call save_weekly_plan with the plan, weekStart date, and a 2-4 sentence performance analysis.

## Rules
- Always include exactly 7 days (Mon–Sun), using type "rest" for off days
- Apply progressive overload when last week's performance was good (RPE ≤ 7, full adherence)
- Reduce load or add recovery if: missed sessions, RPE ≥ 9, injury notes, or fatigue signals
- Rest days have type "rest" and an empty exercises array
- The adjustments array must be specific — cite actual log data, not generic platitudes${
    customInstructions
      ? `\n\n## Athlete's custom instructions (always follow these)\n${customInstructions}`
      : ""
  }`;
}

// ---------------------------------------------------------------------------
// Main agent runner
// ---------------------------------------------------------------------------

const client = new Anthropic();

export async function runWeeklyAgentWorkflow(overrideInstructions?: string): Promise<WeeklyPlan> {
  console.log("[Agent] Starting weekly plan generation...");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "Please analyze my training from last week and generate my workout plan for the upcoming week. Follow your workflow steps.",
    },
  ];

  // Agentic loop
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: buildSystemPrompt(overrideInstructions),
      tools,
      messages,
    });

    console.log(`[Agent] Stop reason: ${response.stop_reason}`);

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Extract final text response
      const textBlock = response.content.find((b) => b.type === "text");
      console.log("[Agent] Done.", textBlock?.text ?? "");
      break;
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }

    // Execute all tool calls in this turn
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      // web_search is server-side — Anthropic executes it transparently,
      // no client-provided tool_result needed or expected.
      if (block.name === "web_search") continue;

      console.log(`[Agent] Tool call: ${block.name}`);
      const result = executeTool(block.name, block.input as Record<string, unknown>);
      console.log(`[Agent] Tool result:`, JSON.stringify(result).slice(0, 200));

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    // Feed results back
    messages.push({ role: "user", content: toolResults });
  }

  // Return the saved plan
  const saved = getLatestPlan();
  if (!saved) throw new Error("Agent completed but no plan was saved.");

  return WeeklyPlanSchema.parse(JSON.parse(saved.plan as string));
}

// ---------------------------------------------------------------------------
// Manual trigger (for testing without the scheduler)
// ---------------------------------------------------------------------------

export async function generatePlanNow(overrideInstructions?: string): Promise<WeeklyPlan> {
  return runWeeklyAgentWorkflow(overrideInstructions);
}
