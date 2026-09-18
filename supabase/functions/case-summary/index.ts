// ResolveAI AI Case Summary backend function.
//
// Generates a concise AI summary of an escalated support case for a Human
// Agent. This is a separate summarization layer only — it never touches the
// Qwen investigation/decision pipeline. The Qwen API token lives in the
// function environment and is never exposed to the frontend.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session-id",
};

const AI_API_URL = "https://api.enter.pro/code/api/v1/ai/chat/completions";
const AI_MODEL = "alibaba/qwen-3.7-plus";
const ENTER_PROJECT_ID = "ff70718998987a15db5307804a6d9c00";

const SUMMARY_FIELDS = [
  "issue",
  "investigation",
  "why_escalated",
  "recommended_agent_check",
];

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildSummaryPrompt(caseData: Record<string, unknown>): string {
  return `You are ResolveAI's case summarizer. A Human Support Agent needs to
understand an escalated support case quickly.

Summarize the case information below. Base the summary ONLY on the information
provided. Do not invent facts that are not present in the data.

CASE INFORMATION:
${JSON.stringify(caseData, null, 2)}

Write a concise, practical summary with exactly these four sections:

- "issue": a one or two sentence statement of the customer's problem.
- "investigation": what the recorded data shows about the customer, order,
  delivery, payment, refund, support history, and applicable policy.
- "why_escalated": why the AI escalated the case to a human agent.
- "recommended_agent_check": the single most useful thing the agent should
  verify or do next, based only on the available information.

Keep each section to 1-3 sentences. Do not include markdown, explanations
outside the JSON, or code fences.

Return ONLY valid JSON in this exact structure:
{
    "issue": "...",
    "investigation": "...",
    "why_escalated": "...",
    "recommended_agent_check": "..."
}
`;
}

function validateSummary(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const field of SUMMARY_FIELDS) {
    const text = obj[field];
    if (typeof text !== "string" || text.trim() === "") {
      return null;
    }
    result[field] = text.trim();
  }

  return result;
}

async function generateSummary(
  prompt: string,
): Promise<Record<string, string> | null> {
  const AI_API_TOKEN = Deno.env.get("AI_API_TOKEN_ff7071899898");

  if (!AI_API_TOKEN) {
    return null;
  }

  try {
    const response = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-Session-ID": crypto.randomUUID(),
        "X-Enter-Project-ID": ENTER_PROJECT_ID,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      console.error("case-summary upstream error", response.status);
      return null;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim() === "") {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    return validateSummary(parsed);
  } catch (error) {
    console.error("case-summary generation error", error);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Only authenticated human agents may request a summary.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();

    const { data: userData, error: userError } = await supabase.auth.getUser(
      jwt,
    );

    if (userError || !userData?.user) {
      return json({ error: "Authentication required." }, 401);
    }

    // Authorization: only active approved support agents may request a
    // summary. The service-role client reads agent_profiles; the same rule is
    // enforced in RLS for direct data access.
    const { data: agentProfile, error: profileError } = await supabase
      .from("agent_profiles")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("active", true)
      .in("role", ["agent", "admin"])
      .maybeSingle();

    if (profileError || !agentProfile) {
      return json(
        { error: "Your account is not authorized as a support agent." },
        403,
      );
    }

    const body = (await req.json()) as { case?: unknown };
    const caseData = body?.case;

    if (!caseData || typeof caseData !== "object") {
      return json({ error: "case data is required." }, 400);
    }

    const prompt = buildSummaryPrompt(
      caseData as Record<string, unknown>,
    );

    const summary = await generateSummary(prompt);

    if (!summary) {
      return json({ error: "AI summary unavailable." });
    }

    return json(summary);
  } catch (error) {
    console.error("case-summary function error", error);
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "AI summary unavailable.",
      },
      500,
    );
  }
});
