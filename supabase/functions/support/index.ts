// ResolveAI support backend function.
//
// Modular single-file layout: the pipeline stages below are self-contained
// modules (types, http, investigation, llm, prompt, decision, actions,
// escalation, customer response, persistence) orchestrated by Deno.serve at the
// bottom. The public contract and every response shape are unchanged.
//
// NOTE: the Enter deploy bundler ships only this index.ts, so the modules live
// here as clearly separated sections rather than separate files.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ======================================================================
// SHARED TYPES
// ======================================================================

// Shared types for the ResolveAI backend functions.
//
// These are internal types only — they describe the existing data shapes and do
// not change any behavior or the public support API contract.


type JsonObject = Record<string, unknown>;

// The service-role Supabase client used by the backend functions.
type SupabaseClient = ReturnType<typeof createClient>;

// The evidence assembled for one support case (Step 1: investigate).
interface Investigation {
  customer: JsonObject | null;
  order: JsonObject | null;
  ticket_history: JsonObject[];
  policy: JsonObject | null;
  customer_id: string | null;
}

// The row persisted to support_cases for every completed case.
interface SupportCaseRecord {
  case_id: string;
  customer_id: string | null;
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

// ======================================================================
// HTTP HELPERS
// ======================================================================

// Shared HTTP helpers for the ResolveAI backend functions.


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session-id",
};

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

// ======================================================================
// STEP 1 - INVESTIGATION (evidence assembly)
// ======================================================================

// Step 1: investigate the customer's case.
//
// Evidence assembly for one case. The order is the source of truth: when the
// requested order exists, the customer context is the order's owner; when it
// does not exist, no customer is attached (a default/demo customer must never
// be paired with an unverifiable order to manufacture a match).


async function investigate(
  supabase: SupabaseClient,
  orderId: string,
): Promise<Investigation> {
  const orderRes = await supabase
    .from("orders")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderRes.error) {
    console.error("investigate query error", orderRes.error);
    throw new Error(orderRes.error.message);
  }

  const order = (orderRes.data as JsonObject) ?? null;

  const resolvedCustomerId =
    order && typeof order.customer_id === "string"
      ? order.customer_id
      : null;

  const [customerRes, ticketsRes, policyRes] = await Promise.all([
    resolvedCustomerId
      ? supabase
          .from("customers")
          .select("*")
          .eq("customer_id", resolvedCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    resolvedCustomerId
      ? supabase
          .from("tickets")
          .select("*")
          .eq("customer_id", resolvedCustomerId)
          .order("created_date", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("policies")
      .select("*")
      .eq("policy_type", "delivery_refund")
      .order("policy_id", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const res of [customerRes, ticketsRes, policyRes]) {
    if (res.error) {
      console.error("investigate query error", res.error);
      throw new Error(res.error.message);
    }
  }

  return {
    customer: (customerRes.data as JsonObject) ?? null,
    order,
    ticket_history: (ticketsRes.data as JsonObject[]) ?? [],
    policy: (policyRes.data as JsonObject) ?? null,
    customer_id: resolvedCustomerId,
  };
}

// ======================================================================
// LLM HELPER (Qwen chat completions, reusable)
// ======================================================================

// Reusable LLM helper for the ResolveAI backend functions.
//
// Single place for the Enter AI (Qwen) chat-completions call. The API token is
// read from the function environment and never leaves the server. Behavior is
// identical to the previous inline implementation in the support function.

const AI_API_URL = "https://api.enter.pro/code/api/v1/ai/chat/completions";
const AI_MODEL = "alibaba/qwen-3.7-plus";
const ENTER_PROJECT_ID = "ff70718998987a15db5307804a6d9c00";

interface LlmResult {
  status: string;
  message?: string;
  response?: unknown;
}

// Sends one prompt to Qwen and returns the parsed JSON response.
// Never throws: failures are reported through `status` so callers can escalate.
async function askQwen(prompt: string): Promise<LlmResult> {
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

// ======================================================================
// STEP 2 - REASONING PROMPT
// ======================================================================

// Step 2: build the Qwen reasoning prompt.
//
// The prompt text is unchanged from the original implementation — the multi-agent
// phases will extend this module, but Phase 0 preserves it exactly.


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
2. Determine the customer's REQUESTED ACTION first: are they asking for
   information only (order status, delivery status, tracking, a general
   question), or are they asking for an action (refund, compensation,
   cancellation, or another resolution)?
   - Information/status request: decide "inform" and provide the order
     status. Do NOT infer a refund request merely because the order is
     delayed and happens to be eligible for a refund.
   - Action request: evaluate the request against the applicable policy.
3. Examine the customer information, order information, previous support
   tickets, and relevant company policy.
4. Reason only from the evidence provided.
5. Only when the customer clearly requests a refund/compensation AND clearly
   satisfies the relevant policy, recommend approval and the appropriate
   automated action.
6. If the request clearly does not qualify for the stated policy and is a
   simple policy rejection, you may deny the request.
7. If the request is unusual, outside the normal policy flow, requires human
   judgment, involves an exceptional request, or cannot be safely resolved
   automatically, recommend escalation.
8. If information is missing, conflicting, or insufficient to make a safe
   decision, recommend escalation.
9. Give a short explanation based only on the available evidence.

IMPORTANT DECISION RULES:

- The customer only asks for information (order status, delivery status,
  tracking, or a general question) and requests no action:
  decision = "inform", action = "no_action"
  Policy eligibility is NOT evaluated for information requests.

- The customer clearly requests a refund/compensation AND clearly satisfies
  the relevant policy:
  decision = "approve"

- The customer clearly requests a refund/compensation but clearly does not
  qualify for a straightforward policy reason:
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
- "inform"
- "approve"
- "deny"
- "escalate"

The "action" field MUST be exactly one of:
- "refund_shipping_fee"
- "human_review"
- "no_action"

Rules for decision and action:

- If decision is "inform", action MUST be "no_action".
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
    "decision": "inform OR approve OR deny OR escalate",
    "reason": "short explanation based on the evidence",
    "action": "refund_shipping_fee OR human_review OR no_action",
    "evidence": [
        "important evidence 1",
        "important evidence 2"
    ]
}
`;
}

// ======================================================================
// STEP 4 - DECISION VALIDATION
// ======================================================================

// Step 4: validate Qwen's decision.
//
// Deterministic guard rails around the model output: the decision/action
// allowlists and cross-field rules are unchanged.


const ALLOWED_DECISIONS = new Set(["inform", "approve", "deny", "escalate"]);
const ALLOWED_ACTIONS = new Set(["refund_shipping_fee", "human_review", "no_action"]);

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

  if (decision === "inform" && action !== "no_action") {
    return {
      valid: false,
      reason: "Informational responses must use the no_action action.",
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

// ======================================================================
// STEPS 5 & 6 - ACTION EXECUTION + VERIFICATION
// ======================================================================

// Steps 5 & 6: execute an automatically approved action and verify it happened.
//
// Refund and no-action behavior is unchanged.


async function executeAction(
  supabase: SupabaseClient,
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

async function verifyAction(
  supabase: SupabaseClient,
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

// ======================================================================
// STEP 7 - ESCALATION CASE
// ======================================================================

// Step 7: build the escalation case for human review.
//
// Escalation payload shape is unchanged.


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

// ======================================================================
// STEP 8 - CUSTOMER RESPONSE
// ======================================================================

// Step 8: build the customer-friendly response.
//
// Wording and status values are unchanged, including the neutral escalation
// message used when an order could not be verified.


// Builds a concise human-readable description of the order's current status
// from the real order fields. Never invents a delay value.
function buildOrderStatusText(order: JsonObject): string {
  const status = typeof order.status === "string" ? order.status : "";
  const shipping =
    typeof order.shipping_type === "string" ? order.shipping_type : "";
  const delay =
    typeof order.delivery_days_delayed === "number"
      ? order.delivery_days_delayed
      : null;
  const expected =
    typeof order.expected_delivery === "string"
      ? order.expected_delivery
      : "";
  const actual =
    typeof order.actual_delivery === "string" ? order.actual_delivery : "";

  const bits: string[] = [];

  if (shipping) {
    bits.push(shipping.toLowerCase());
  }

  if (delay !== null && delay > 0) {
    bits.push(`delayed by ${delay} ${delay === 1 ? "day" : "days"}`);
  } else if (delay !== null) {
    bits.push("on schedule");
  }

  if (actual) {
    bits.push(`delivered on ${actual}`);
  } else if (expected) {
    bits.push(`expected delivery on ${expected}`);
  }

  if (
    status &&
    !bits.some((b) => b.includes(status.toLowerCase()))
  ) {
    bits.push(status);
  }

  return bits.length > 0 ? bits.join(" · ") : "status currently being updated";
}

function buildCustomerResponse(
  decision: JsonObject,
  investigation: Investigation,
  requestedOrderId?: string,
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

  if (decisionType === "inform") {
    return {
      status: "resolved",
      message: `Hi ${customerName}, here is the current status of your order #${orderId}: ${buildOrderStatusText(order)}.`,
      details:
        "No action was required. This information is based on the recorded order details.",
    };
  }

  if (decisionType === "escalate") {
    // A request for an order that could not be verified must not claim a
    // verified customer name: use neutral wording and reference the requested
    // order number instead.
    if (!order) {
      return {
        status: "escalated",
        message: requestedOrderId
          ? `Your request has been forwarded to a human support agent because order #${requestedOrderId} could not be verified.`
          : "Your request has been forwarded to a human support agent because the order details could not be verified.",
        details:
          "We could not automatically resolve this request based on the available information and policy.",
      };
    }

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

  // Unreachable fallback for unknown decision types: keep the escalation safe
  // and neutral when the order could not be verified.
  return {
    status: "escalated",
    message: orderId
      ? `Hi ${customerName}, your request for order #${orderId} has been forwarded to a human support agent.`
      : requestedOrderId
        ? `Your request has been forwarded to a human support agent because order #${requestedOrderId} could not be verified.`
        : "Your request has been forwarded to a human support agent because the order details could not be verified.",
    details: "The request requires further review.",
  };
}

// ======================================================================
// CASE PERSISTENCE
// ======================================================================

// Persist the completed case so support history is kept in the database.
//
// Persistence is best-effort: an error here is logged but must never break the
// support response the customer receives. Behavior is unchanged.


async function persistCaseRecord(
  supabase: SupabaseClient,
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

// ======================================================================
// ORCHESTRATOR - support pipeline (Deno.serve)
// ======================================================================

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

    const orderId = body.order_id.trim();
    const message = body.message;

    // Generate a unique case ID for every support request
    const caseId = `CASE-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    // Step 1: investigate the customer's case.
    // The order is authoritative: the customer context is resolved from the
    // order's owner, and a nonexistent order never gets a customer attached.
    const investigation = await investigate(supabase, orderId);

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

      const customerResponse = buildCustomerResponse(decision, investigation, orderId);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: investigation.customer_id,
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

      const customerResponse = buildCustomerResponse(decision, investigation, orderId);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: investigation.customer_id,
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

      const customerResponse = buildCustomerResponse(decision, investigation, orderId);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: investigation.customer_id,
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

    // Step 9b: informational / order-status request — no action is executed.
    if (validation.decision === "inform") {
      // An informational response requires the order record; without it the
      // case is safely escalated to human review instead.
      if (!investigation.order) {
        const escalationReason =
          "The order details could not be verified.";

        const escalationCase = createEscalationCase({
          customerMessage: message,
          investigation,
          qwenResponse,
          reason: escalationReason,
        });

        const escalatedDecision = {
          decision: "escalate",
          reason: escalationReason,
          action: "human_review",
          evidence: qwenObj.evidence ?? [],
          intent: qwenObj.intent ?? "",
        };

        const customerResponse = buildCustomerResponse(
          escalatedDecision,
          investigation,
          orderId,
        );

        await persistCaseRecord(supabase, {
          case_id: caseId,
          customer_id: investigation.customer_id,
          order_id: orderId,
          customer_message: message,
          intent:
            typeof qwenObj.intent === "string" ? qwenObj.intent : "",
          decision: "escalate",
          reason: escalationReason,
          action: "human_review",
          evidence: Array.isArray(qwenObj.evidence)
            ? qwenObj.evidence
            : [],
          action_status: "not_required",
          verification_status: "not_required",
          resolution_status: customerResponse.status,
          escalation_reason: escalationReason,
          case_status: "escalated",
        });

        return json({
          case_id: caseId,
          customer_message: message,
          investigation,
          qwen_response: qwenResponse,
          decision: escalatedDecision,
          action_status: "not_required",
          verification_status: "not_required",
          resolution_status: customerResponse.status,
          customer_response: customerResponse,
          escalation_case: escalationCase,
        });
      }

      const customerResponse = buildCustomerResponse(decision, investigation, orderId);

      await persistCaseRecord(supabase, {
        case_id: caseId,
        customer_id: investigation.customer_id,
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
        escalation_reason: null,
        case_status: null,
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
      orderId,
    );

    // Step 14: persist the case record and return the final response
    await persistCaseRecord(supabase, {
      case_id: caseId,
      customer_id: investigation.customer_id,
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