import Anthropic from "@anthropic-ai/sdk";
import type { UserProfile } from "./db.js";

const client = new Anthropic();

// ---------------------------------------------------------------------------
// System prompt for the research agent
// ---------------------------------------------------------------------------

function buildResearchSystemPrompt(profile: UserProfile): string {
  const goals = JSON.parse(profile.goals as string) as string[];
  const equipment = JSON.parse(profile.equipment as string) as string[];

  return `You are a sports science researcher and elite strength & conditioning coach. Your job is to research a specific training goal and produce an actionable training brief that will be used directly as standing instructions for an AI personal trainer.

The athlete you are researching for:
- Name: ${profile.name}
- Fitness level: ${profile.fitness_level}
- Trains: ${profile.days_per_week} days/week
- Current goals: ${goals.join(", ")}
- Available equipment: ${equipment.join(", ")}
- Injuries/constraints: ${profile.injuries || "none"}

Use web_search to gather current, specific information about the training topic. Aim for 3–5 searches covering:
1. What the event/goal involves (structure, distances, movements, demands)
2. Optimal periodization and training phases (base → build → peak if applicable)
3. Key workouts and exercises that experts recommend
4. Common mistakes and what to avoid
5. How to adapt for the athlete's fitness level and equipment

After your research, write a **Training Brief** in this exact structure (use markdown headers):

## Overview
What this goal/event demands physically and why standard training isn't enough.

## Key Training Pillars
The 3–5 most important training components, ranked by priority. For each: name, why it matters, rough weekly volume.

## Weekly Structure Recommendation
How to distribute training types across ${profile.days_per_week} training days. Be specific (e.g. "Day 1: long run + core, Day 2: strength lower body…").

## Must-Include Workouts
3–6 specific workout types or sessions that are non-negotiable for this goal. Include rough durations and intensities.

## Progression Guidelines
How intensity, volume, or complexity should evolve week over week.

## Profile-Specific Notes
Adjustments specific to this athlete's level (${profile.fitness_level}), equipment (${equipment.join(", ")}), and any constraints.

Be concrete and specific — avoid generic advice. This brief will govern every weekly training plan the AI generates going forward.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a research subagent that searches the web for a specific training topic
 * and synthesizes the findings into a structured training brief.
 *
 * web_search_20250305 is a server-side tool — Anthropic's API executes the
 * searches transparently and the model sees the results inline. The client
 * receives the final synthesized response in a single API round-trip.
 */
export async function runResearchAgent(
  topic: string,
  profile: UserProfile
): Promise<string> {
  console.log(`[Research] Starting research: "${topic}"`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Research this training topic and produce the full Training Brief: "${topic}"`,
    },
  ];

  // web_search_20250305 is server-side — the API handles searches
  // transparently within the same call. We loop only in case the model
  // needs multiple agentic turns for non-search tool calls (there are none
  // here, but the loop is safe boilerplate).
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: buildResearchSystemPrompt(profile),
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages,
    });

    console.log(`[Research] Stop reason: ${response.stop_reason}`);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(`[Research] Brief ready — ${text.length} chars`);
      return text;
    }

    // If the model uses non-web-search tools (shouldn't happen here),
    // return an empty result for them and continue.
    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .filter((b) => b.name !== "web_search") // web_search is server-side
        .map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: JSON.stringify({ error: `Unknown tool: ${b.name}` }),
        }));

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      } else {
        // Only web_search tool_use blocks — model will continue on its own
        // This path shouldn't be reached for server-side tools, but handle gracefully
        break;
      }
      continue;
    }

    throw new Error(`[Research] Unexpected stop_reason: ${response.stop_reason}`);
  }

  // Fallback: return whatever text we have
  const lastAssistant = [...messages].reverse().find((m: Anthropic.MessageParam) => m.role === "assistant");
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    return (lastAssistant.content as Anthropic.ContentBlock[])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  throw new Error("[Research] Agent completed without producing a brief.");
}
