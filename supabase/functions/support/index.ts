// ResolveAI support backend function.
//
// Mirrors the original ResolveAI Python backend (POST /api/support) so the
// response structure stays identical:
//   case_id, customer_message, investigation, qwen_response, decision,
//   action_result, action_status, verification_status, resolution_status,
//   customer_response, escalation_case (only on escalation paths).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session-id",
};

const AI_API_URL = "https://api.enter.pro/code/api/v1/ai/chat/completions";
const AI_MODEL = "alibaba/qwen-3.7-plus";
const ENTER_PROJECT_ID = "ff70718998987a15db5307804a6d9c00";

const ALLOWED_DECISIONS = new Set(["approve", "deny", "escalate"]);
const ALLOWED_ACTIONS = new Set(["refund_shipping_fee", "human_review", "no_action"]);

type JsonObject = Record<string, unknown>;

interface Investigation {
  customer: JsonObject | null;
  order: JsonObject | null;
  ticket_history: JsonObject[];
  policy: JsonObject | null;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

// Step 1: investigate the customer's case
async function investigate(
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  orderId: string,
): Promise<Investigation> {
  const [customerRes, orderRes, ticketsRes, policyRes] = await Promise.all([
    supabase.from("customers").select("*").eq("customer_id", customerId).maybeSingle(),
    supabase.from("orders").select("*").eq("order_id", orderId).maybeSingle(),
    supabase
      .from("tickets")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_date", { ascending: true }),
    supabase
      .from("policies")
      .select("*")
      .eq("policy_type", "delivery_refund")
      .order("policy_id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const res of [customerRes, orderRes, ticketsRes, policyRes]) {
    if (res.error) {
      console.error("investigate query error", res.error);
      throw new Error(res.error.message);
    }
  }

  return {
    customer: (customerRes.data as JsonObject) ?? null,
    order: (orderRes.data as JsonObject) ?? null,
    ticket_history: (ticketsRes.data as JsonObject[]) ?? [],
    policy: (policyRes.data as JsonObject) ?? null,
  };
}

// Step 2: build the Qwen reasoning prompt
function buildQwenPrompt(message: string, investigation: Investigation): string {
  return `You are ResolveAI, an autonomous customer support reasoning agent.

Your task is to investigate the customer's complaint using the evidence provided
and decide whether the case can be resolved automatically or should be escalated
to a human support agent.

CUSTOMER MESSAGE:
${message}

INVESTIGATION DATA:
${JSON.stringify(investigation, null, 2)}

INSTRUCTIONS:

1. Understand the customer's intent from the message.
2. Examine the customer information, order information, previous support tickets,
   and relevant company policy.
3. Reason only from the evidence provided.
4. Decide whether the request can be handled automatically.
5. If the customer clearly satisfies the relevant policy, recommend approval
   and the appropriate automated action.
6. If the request clearly does not qualify for the stated policy and is a simple
   policy rejection, you may deny the request.
7. If the request is unusual, outside the normal policy flow, requires human
   judgment, involves an exceptional request, or cannot be safely resolved
   automatically, recommend escalation.
8. If information is missing, conflicting, or insufficient to make a safe
   decision, recommend escalation.
9. Give a short explanation based only on the available evidence.

IMPORTANT DECISION RULES:

- Clearly eligible under policy:
  decision = "approve"

- Clearly ineligible for a straightforward policy reason:
  decision = "deny"

- Unusual, exceptional, out-of-policy requests that may require human judgment,
  or cases where automatic handling is not appropriate:
  decision = "escalate"

- Missing, conflicting, or insufficient information:
  decision = "escalate"

- If the customer requests something significantly different from what the
  available policy covers, prefer escalation rather than automatically denying
  the request.

The "decision" and "action" fields are controlled by the ResolveAI backend.

The "decision" field MUST be exactly one of:
- "approve"
- "deny"
- "escalate"

The "action" field MUST be exactly one of:
- "refund_shipping_fee"
- "human_review"
- "no_action"

Rules for decision and action:

- If decision is "approve", choose the appropriate automated action.
- If decision is "deny", action MUST be "no_action".
- If decision is "escalate", action MUST be "human_review".
- Never use natural-language variations for the action.

For example:
Use "refund_shipping_fee" instead of
"Process full shipping fee refund".

Return ONLY valid JSON.
Do not include markdown, explanations outside the JSON, or code fences.

Return your answer in this exact JSON structure:

{
    "intent": "customer's main request",
    "decision": "approve OR deny OR escalate",
    "reason": "short explanation based on the evidence",
    "action": "refund_shipping_fee OR human_review OR no_action",
    "evidence": [
        "important evidence 1",
        "important evidence 2"
    ]
}
`;
}

// Step 3: ask Qwen to reason about the case
async function askQwen(
  prompt: string,
): Promise<{ status: string; message?: string; response?: unknown }> {
  const AI_API_TOKEN = Deno.env.get("AI_API_TOKEN_ff7071899898");

  if (!AI_API_TOKEN) {
    return {
      status: "not_configured",
      message: "Qwen API key is not configured yet.",
    };
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
        temperature: 0.2,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMessage = "AI service error";

      const dataMatch = text.match(/data: (.+)/);
      if (dataMatch) {
        try {
          errorMessage = JSON.parse(dataMatch[1])?.error?.message ?? errorMessage;
        } catch {
          // keep default message
        }
      } else {
        try {
          const parsed = JSON.parse(text);
          errorMessage = parsed?.error?.message ?? errorMessage;
        } catch {
          // keep default message
        }
      }

      return { status: "error", message: errorMessage };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim() === "") {
      return { status: "error", message: "AI returned an empty response." };
    }

    try {
      const parsed = JSON.parse(content);
      return { status: "success", response: parsed };
    } catch {
      return {
        status: "success",
        response: content,
        message: "Qwen response was not valid JSON.",
      };
    }
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown AI error",
    };
  }
}

// Step 4: validate Qwen's decision
function validateQwenDecision(
  qwenResult: unknown,
): { valid: boolean; reason: string; decision: string; action: string } {
  const obj = asObject(qwenResult);

  const decision = typeof obj.decision === "string" ? obj.decision : "";
  const action = typeof obj.action === "string" ? obj.action : "";

  if (typeof qwenResult !== "object" || qwenResult === null || Array.isArray(qwenResult)) {
    return {
      valid: false,
      reason: "Qwen response is not a valid JSON object.",
      decision: "escalate",
      action: "human_review",
    };
  }

  if (!ALLOWED_DECISIONS.has(decision)) {
    return {
      valid: false,
      reason: "Qwen returned an unsupported decision.",
      decision: "escalate",
      action: "human_review",
    };
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    return {
      valid: false,
      reason: "Qwen returned an unsupported action.",
      decision: "escalate",
      action: "human_review",
    };
  }

  if (decision === "escalate" && action !== "human_review") {
    return {
      valid: false,
      reason: "Escalation must use the human_review action.",
      decision: "escalate",
      action: "human_review",
    };
  }

  if (decision === "approve" && action === "human_review") {
    return {
      valid: false,
      reason: "An approved case cannot use human_review as its action.",
      decision: "escalate",
      action: "human_review",
    };
  }

  return {
    valid: true,
    reason: "Qwen decision passed backend validation.",
    decision,
    action,
  };
}

// Step 5: execute an automatically approved action
async function executeAction(
  supabase: ReturnType<typeof createClient>,
  action: string,
  investigation: Investigation,
): Promise<JsonObject> {
  const order = investigation.order;

  if (action === "refund_shipping_fee") {
    if (!order) {
      return { status: "failed", action, message: "Order information is missing." };
    }

    const { error } = await supabase
      .from("orders")
      .update({ refund_status: "initiated" })
      .eq("order_id", order.order_id);

    if (error) {
      console.error("execute refund_shipping_fee error", error);
      return { status: "failed", action, message: error.message };
    }

    return {
      status: "completed",
      action,
      order_id: order.order_id,
      refund_status: "initiated",
      message: "Shipping fee refund has been initiated.",
    };
  }

  if (action === "no_action") {
    return { status: "completed", action, message: "No action is required." };
  }

  if (action === "human_review") {
    return {
      status: "escalated",
      action,
      message: "The case has been escalated to a human support agent.",
    };
  }

  return { status: "failed", action, message: "Unsupported action." };
}

// Step 6: verify that the action actually happened
async function verifyAction(
  supabase: ReturnType<typeof createClient>,
  action: string,
  investigation: Investigation,
): Promise<JsonObject> {
  const order = investigation.order;

  if (action === "refund_shipping_fee") {
    if (!order) {
      return { verification_status: "failed" };
    }

    const { data, error } = await supabase
      .from("orders")
      .select("refund_status")
      .eq("order_id", order.order_id)
      .maybeSingle();

    if (error || !data) {
      console.error("verify refund_shipping_fee error", error);
      return { verification_status: "failed" };
    }

    return data.refund_status === "initiated"
      ? { verification_status: "verified" }
      : { verification_status: "failed" };
  }

  if (action === "human_review" || action === "no_action") {
    return { verification_status: "not_required" };
  }

  return { verification_status: "failed" };
}

// Step 7: build the escalation case for human review
function createEscalationCase(input: {
  customerMessage: string;
  investigation: Investigation;
  qwenResponse: unknown;
  reason: string;
}): JsonObject {
  const { customerMessage, investigation, qwenResponse, reason } = input;
  const qwenObj = asObject(qwenResponse);

  return {
    case_status: "escalated",
    escalation_reason: reason,
    customer: investigation.customer,
    order: investigation.order,
    customer_message: customerMessage,
    ai_analysis: {
      intent: qwenObj.intent ?? "",
      decision: qwenObj.decision ?? "",
      reason: qwenObj.reason ?? "",
      evidence: qwenObj.evidence ?? [],
    },
    human_agent_message:
      "This case requires human review. The AI investigation and supporting evidence have been attached for the support agent.",
  };
}

// Step 8: build the customer-friendly response
function buildCustomerResponse(
  decision: JsonObject,
  investigation: Investigation,
  actionResult?: JsonObject,
): JsonObject {
  const order = investigation.order;
  const customer = investigation.customer;

  const decisionType = decision.decision;
  const action = decision.action;

  const customerName =
    customer && typeof customer.name === "string" ? customer.name : "Customer";
  const orderId =
    order && typeof order.order_id === "string" ? order.order_id : "";

  if (decisionType === "approve") {
    if (action === "refund_shipping_fee") {
      return {
        status: "resolved",
        message: `Hi ${customerName}, your shipping fee refund for order #${orderId} has been initiated successfully.`,
        details:
          "Your order qualified for the refund because it used Express delivery and was delayed by 2 or more days.",
      };
    }

    return {
      status: "resolved",
      message: `Hi ${customerName}, your request for order #${orderId} has been successfully processed.`,
      details:
        typeof decision.reason === "string" ? decision.reason : "Your request was approved.",
    };
  }

  if (decisionType === "escalate") {
    return {
      status: "escalated",
      message: `Hi ${customerName}, your request for order #${orderId} has been forwarded to a human support agent.`,
      details:
        "We could not automatically resolve this request based on the available information and policy.",
    };
  }

  if (decisionType === "deny") {
    return {
      status: "not_approved",
      message: `Hi ${customerName}, we could not approve your request for order #${orderId}.`,
      details:
        typeof decision.reason === "string"
          ? decision.reason
          : "The request does not meet the applicable policy conditions.",
    };
  }

  return {
    status: "escalated",
    message: `Hi ${customerName}, your request for order #${orderId} has been forwarded to a human support agent.`,
    details: "The request requires further review.",
  };
}

// Persist the completed case so support history is kept in the database.
// Persistence is best-effort: an error here is logged but must never break the
// support response the customer receives.
interface SupportCaseRecord {
  case_id: string;
  customer_id: string;
  order_id: string;
  customer_message: string;
  intent: string;
  decision: string;
  reason: string;
  action: string;
  evidence: unknown[];
  action_status: string;
  verification_status: string;
  resolution_status: string;
  escalation_reason: string | null;
  case_status: string | null;
}

async function persistCaseRecord(
  supabase: ReturnType<typeof createClient>,
  record: SupportCaseRecord,
): Promise<void> {
  try {
    const { error } = await supabase.from("support_cases").insert(record);

    if (error) {
      console.error("Failed to persist support case", error);
    }
  } catch (error) {
    console.error("Failed to persist support case", error);
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

    const body = (await req.json()) as {
      customer_id?: string;
      order_id?: string;
      message?: string;
    };

    if (
      typeof body.customer_id !== "string" ||
      body.customer_id.trim() === "" ||
      typeof body.order_id !== "string" ||
      body.order_id.trim() === "" ||
      typeof body.message !== "string"
    ) {
      return json(
        { error: "customer_id, order_id and message are required." },
        400,
      );
    }

    const customerId = body.customer_id.trim();
    const orderId = body.order_id.trim();
    const message = body.message;

    // Generate a unique case ID for every support request
    const caseId = `CASE-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    // Step 1: investigate the customer's case
    const investigation = await investigate(supabase, customerId, orderId);

    // Step 2: build the Qwen reasoning prompt
    const qwenPrompt = buildQwenPrompt(message, investigation);

    // Step 3: ask Qwen to reason about the case
    const qwenResult = await askQwen(qwenPrompt);

    // Step 4: if Qwen is unavailable, escalate
    if (qwenResult.status !== "success") {
      const decision = {
        decision: "escalate",
        reason: "AI reasoning was unavailable.",
        action: "human_review",
        evidence: [],
        intent: "",
      };

      const escalationCase = createEscalationCase({
        customerMessage: message,
        investigation,
        qwenResponse: {},
        reason: "AI reasoning was unavailable.",
      });

      const customerResponse = buildCustomerResponse(decision, investigation);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: customerId,
        order_id: orderId,
        customer_message: message,
        intent: decision.intent,
        decision: decision.decision,
        reason: decision.reason,
        action: decision.action,
        evidence: decision.evidence,
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        escalation_reason: escalationCase.escalation_reason,
        case_status: "escalated",
      });

      return json({
        case_id: caseId,
        customer_message: message,
        investigation,
        decision,
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        customer_response: customerResponse,
        escalation_case: escalationCase,
      });
    }

    // Step 5: get Qwen's structured response
    const qwenResponse = qwenResult.response;

    // Step 6: validate Qwen's decision
    const validation = validateQwenDecision(qwenResponse);

    // Step 7: if Qwen gives an invalid response, escalate
    if (!validation.valid) {
      const qwenObj = asObject(qwenResponse);

      const decision = {
        decision: "escalate",
        reason: validation.reason,
        action: "human_review",
        evidence: qwenObj.evidence ?? [],
        intent: qwenObj.intent ?? "",
      };

      const escalationCase = createEscalationCase({
        customerMessage: message,
        investigation,
        qwenResponse: qwenObj,
        reason: validation.reason,
      });

      const customerResponse = buildCustomerResponse(decision, investigation);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: customerId,
        order_id: orderId,
        customer_message: message,
        intent: typeof decision.intent === "string" ? decision.intent : "",
        decision: decision.decision,
        reason: decision.reason,
        action: decision.action,
        evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        escalation_reason: escalationCase.escalation_reason,
        case_status: "escalated",
      });

      return json({
        case_id: caseId,
        customer_message: message,
        investigation,
        qwen_response: qwenResponse,
        decision,
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        customer_response: customerResponse,
        escalation_case: escalationCase,
      });
    }

    // Step 8: build the validated decision
    const qwenObj = asObject(qwenResponse);
    const decision = {
      decision: validation.decision,
      reason:
        typeof qwenObj.reason === "string"
          ? qwenObj.reason
          : "No reason provided.",
      action: validation.action,
      evidence: qwenObj.evidence ?? [],
      intent: qwenObj.intent ?? "",
    };

    // Step 9: handle human escalation
    if (validation.decision === "escalate") {
      const escalationCase = createEscalationCase({
        customerMessage: message,
        investigation,
        qwenResponse,
        reason:
          typeof qwenObj.reason === "string"
            ? qwenObj.reason
            : "Human review is required.",
      });

      const customerResponse = buildCustomerResponse(decision, investigation);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: customerId,
        order_id: orderId,
        customer_message: message,
        intent: typeof decision.intent === "string" ? decision.intent : "",
        decision: decision.decision,
        reason: decision.reason,
        action: decision.action,
        evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        escalation_reason: escalationCase.escalation_reason,
        case_status: "escalated",
      });

      return json({
        case_id: caseId,
        customer_message: message,
        investigation,
        qwen_response: qwenResponse,
        decision,
        action_status: "not_required",
        verification_status: "not_required",
        resolution_status: customerResponse.status,
        customer_response: customerResponse,
        escalation_case: escalationCase,
      });
    }

    // Step 10: execute an automatically approved action
    const actionResult = await executeAction(
      supabase,
      validation.action,
      investigation,
    );

    // Step 11: verify that the action actually happened
    const verification = await verifyAction(
      supabase,
      validation.action,
      investigation,
    );

    // Step 12: determine action status
    let actionStatus = "in_progress";
    if (actionResult.status === "completed") {
      actionStatus = "completed";
    } else if (actionResult.status === "failed") {
      actionStatus = "failed";
    }

    // Step 13: build customer-friendly response
    const customerResponse = buildCustomerResponse(
      decision,
      investigation,
      actionResult,
    );

    // Step 14: persist the case record and return the final response
    await persistCaseRecord(supabase, {
      case_id: caseId,
      customer_id: customerId,
      order_id: orderId,
      customer_message: message,
      intent: typeof decision.intent === "string" ? decision.intent : "",
      decision: decision.decision,
      reason: decision.reason,
      action: decision.action,
      evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
      action_status: actionStatus,
      verification_status:
        typeof verification.verification_status === "string"
          ? verification.verification_status
          : "failed",
      resolution_status: customerResponse.status,
      escalation_reason: null,
      case_status: null,
    });

    return json({
      case_id: caseId,
      customer_message: message,
      investigation,
      qwen_response: qwenResponse,
      decision,
      action_result: actionResult,
      action_status: actionStatus,
      verification_status: verification.verification_status,
      resolution_status: customerResponse.status,
      customer_response: customerResponse,
    });
  } catch (error) {
    console.error("support function error", error);
    return json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      500,
    );
  }
});
