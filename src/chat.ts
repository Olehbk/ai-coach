import Anthropic from "@anthropic-ai/sdk";
import { getProfile, getRecentLogs, getLatestPlan, updateProfile, type WorkoutLog } from "./db.js";
import { generatePlanNow } from "./agent.js";
import { rescheduleTask } from "./scheduler.js";
import { runResearchAgent } from "./research.js";

const client = new Anthropic();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildChatSystemPrompt(): string {
  return `You are a friendly, encouraging personal training coach AI. You have a conversational interface with the athlete to help them:

1. **Customize their workout plan** — When they say things like "build my plan more focused on strength" or "I want less cardio", ask 1–2 clarifying questions to understand exactly what they want, then save their preferences with update_profile (custom_plan_instructions field) and offer to regenerate the plan.

2. **Research-driven goal planning** — When the user mentions a specific event, competition, or specialized goal (Hyrox, marathon, powerlifting meet, triathlon, CrossFit competition, obstacle course race, sport season, etc.), launch a research subagent to gather expert training knowledge before building the plan.

3. **Set persistent training preferences** — Update goals, equipment, injuries, fitness level, training days via update_profile.

4. **Configure weekly email delivery** — When they ask to receive their plan by email (e.g. "send me my plan every Sunday at 8am"), confirm the day and time, then call update_email_schedule. If they say "stop sending emails", disable it.

5. **Answer training questions** — Explain their current plan, review recent logs, advise on recovery, answer exercise questions.

## How to handle specialized event/goal requests
When the user mentions training for a specific event or competition (Hyrox, marathon, 5K, powerlifting meet, etc.):
1. Confirm the goal briefly (e.g. "Got it — when is the event? Any target date?")
2. Tell them: "Let me research the best training approach for this — give me a moment."
3. Call research_topic with a detailed topic string that includes the event + the athlete's context (e.g. "Hyrox preparation for intermediate athlete training 4 days/week with barbell and dumbbells, event in 12 weeks")
4. Review the returned research brief
5. Call update_profile to save the key guidelines as custom_plan_instructions (summarize the brief into clear, actionable standing instructions)
6. Ask if they'd like a new plan generated now with these guidelines
7. If yes, call generate_plan

## How to handle general plan customization requests
When user says something like "I want my plan built a certain way":
1. Ask 1–2 short clarifying questions (specific focus, days, intensity, anything to avoid?)
2. Once you have enough info, call update_profile with the new custom_plan_instructions
3. Ask if they'd like you to regenerate the plan now with these changes
4. If yes, call generate_plan

## How to handle schedule requests
When user mentions email delivery:
1. Confirm day of week and time (e.g. "Every Sunday at 8am — does that work?")
2. Call update_email_schedule with the appropriate cron and enabled=true
3. Confirm back with a friendly summary

## Cron quick reference
- Sunday 8am  → "0 8 * * 0"
- Monday 7am  → "0 7 * * 1"
- Saturday 9am → "0 9 * * 6"
- Friday 6pm  → "0 18 * * 5"
Day numbers: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6

## Rules
- Be conversational and coach-like — concise, warm, motivating
- Use the athlete's name if you know it
- Ask before making changes, don't assume
- When generating a plan, warn that it takes ~30 seconds
- research_topic takes ~20 seconds — warn the user before calling it
- Today is ${new Date().toISOString().slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const chatTools: Anthropic.Tool[] = [
  {
    name: "get_user_profile",
    description:
      "Get the athlete's current profile: name, fitness level, goals, equipment, injuries, days per week, custom plan instructions, and email schedule.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_recent_logs",
    description: "Get the athlete's recent workout logs (last 14 days).",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_current_plan",
    description: "Get the most recently generated weekly training plan.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "update_profile",
    description:
      "Update any combination of the athlete's profile fields. All fields are optional — only pass what changed.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        fitness_level: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
        goals: { type: "array", items: { type: "string" } },
        equipment: { type: "array", items: { type: "string" } },
        injuries: { type: "string" },
        days_per_week: { type: "number" },
        custom_plan_instructions: {
          type: "string",
          description:
            "Persistent instructions always applied when generating plans. E.g. 'Focus on powerlifting (squat/bench/deadlift). Minimal cardio. Linear progression.' Set to empty string to clear.",
        },
      },
      required: [],
    },
  },
  {
    name: "update_email_schedule",
    description: "Set or change the weekly email delivery schedule for the training plan.",
    input_schema: {
      type: "object" as const,
      properties: {
        cron_expression: {
          type: "string",
          description: "Cron expression, e.g. '0 8 * * 0' = Sunday 8am",
        },
        enabled: {
          type: "boolean",
          description: "true to enable email delivery, false to disable",
        },
      },
      required: ["cron_expression", "enabled"],
    },
  },
  {
    name: "research_topic",
    description:
      "Launch a research subagent that searches the web for a specific training goal or event (e.g. 'Hyrox', 'marathon', 'powerlifting meet', 'triathlon') and returns a structured training brief with evidence-based recommendations. Use this whenever the user mentions a specific competition, event, or specialized training goal — before updating their plan. Takes ~20 seconds.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description:
            "Specific topic to research. Include event name + athlete context for better results. E.g. 'Hyrox preparation for intermediate athlete training 4 days/week with barbell and dumbbells, event in 12 weeks'",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "generate_plan",
    description:
      "Trigger the training AI to generate a new weekly plan. Use after updating preferences or when the user asks to regenerate. Optionally pass extra_instructions for one-time overrides (not saved).",
    input_schema: {
      type: "object" as const,
      properties: {
        extra_instructions: {
          type: "string",
          description:
            "One-time instructions for this specific generation only, e.g. 'Skip all leg work this week — knee flare-up'",
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor (async to handle generate_plan)
// ---------------------------------------------------------------------------

async function executeChatTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "get_user_profile": {
      const p = getProfile();
      return {
        ...p,
        goals: JSON.parse(p.goals as string),
        equipment: JSON.parse(p.equipment as string),
      };
    }

    case "get_recent_logs": {
      return getRecentLogs(14).map((l: WorkoutLog) => ({
        ...l,
        planned_exercises: JSON.parse(l.planned_exercises as string),
        actual_exercises: JSON.parse(l.actual_exercises as string),
      }));
    }

    case "get_current_plan": {
      const plan = getLatestPlan();
      if (!plan) return null;
      return { ...plan, plan: JSON.parse(plan.plan as string) };
    }

    case "update_profile": {
      const update: Record<string, unknown> = {};
      for (const key of [
        "name",
        "fitness_level",
        "injuries",
        "days_per_week",
        "custom_plan_instructions",
      ] as const) {
        if (key in input) update[key] = input[key];
      }
      // goals and equipment come as arrays from Claude — stringify for DB
      if ("goals" in input) update.goals = JSON.stringify(input.goals);
      if ("equipment" in input) update.equipment = JSON.stringify(input.equipment);

      const updated = updateProfile(update as Parameters<typeof updateProfile>[0]);
      return {
        success: true,
        profile: {
          ...updated,
          goals: JSON.parse(updated.goals as string),
          equipment: JSON.parse(updated.equipment as string),
        },
      };
    }

    case "update_email_schedule": {
      const { cron_expression, enabled } = input as {
        cron_expression: string;
        enabled: boolean;
      };
      updateProfile({
        email_schedule: cron_expression,
        email_enabled: enabled ? 1 : 0,
      } as Parameters<typeof updateProfile>[0]);
      rescheduleTask(enabled ? cron_expression : null);
      return { success: true, schedule: cron_expression, enabled };
    }

    case "research_topic": {
      const { topic } = input as { topic: string };
      try {
        const profile = getProfile();
        const brief = await runResearchAgent(topic, profile);
        return { success: true, brief };
      } catch (err) {
        return { error: String(err) };
      }
    }

    case "generate_plan": {
      const { extra_instructions } = input as { extra_instructions?: string };
      try {
        const plan = await generatePlanNow(extra_instructions);
        return { success: true, weekOf: plan.weekOf, summary: plan.summary, weeklyGoal: plan.weeklyGoal };
      } catch (err) {
        return { error: String(err) };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Public API: run one chat turn
// ---------------------------------------------------------------------------

export type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * Run one conversational turn.
 * @param history  Previous user/assistant messages (text only, no tool calls)
 * @param userMessage  The new user message
 * @returns  The assistant's text reply
 */
export async function runChatTurn(
  history: ChatMessage[],
  userMessage: string
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  // Agentic loop (tool calls are transparent to the caller)
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildChatSystemPrompt(),
      tools: chatTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`[Chat] Tool call: ${block.name}`);
      const result = await executeChatTool(
        block.name,
        block.input as Record<string, unknown>
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
