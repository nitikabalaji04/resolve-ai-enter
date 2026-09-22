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

// The Triage Agent's structured classification (Phase 1).
interface TriageResult {
  intent: string;
  urgency: string;
  domains: string[];
  reason: string;
  confidence: number;
}

// One executed investigation domain (Phase 2A).
interface DomainResult {
  domain: string;
  status: string;
  data: unknown;
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
// STEP 1 - INVESTIGATION (full investigation, compatibility path)
// ======================================================================

// Step 1: investigate the customer's case.
//
// Evidence assembly for one case. The order is the source of truth: when the
// requested order exists, the customer context is the order's owner; when it
// does not exist, no customer is attached (a default/demo customer must never
// be paired with an unverifiable order to manufacture a match).
//
// Phase 2A: this is now a thin compatibility wrapper over the domain planner —
// it runs the FULL domain set (order + delivery + customer + policy) and
// returns the same investigation shape as before. It is used as the safe
// fallback whenever a plan cannot be trusted. The original queries now live in
// the domain executors below, so there is a single source of truth.

async function investigate(
  supabase: SupabaseClient,
  orderId: string,
): Promise<Investigation> {
  const orderRow = await resolveOrderRow(supabase, orderId);

  const { investigation } = await runInvestigationPlan(
    supabase,
    orderId,
    { domains: DOMAINS },
    orderRow,
  );

  return investigation;
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
// `options` is optional and defaults to the original reasoning settings, so
// existing callers are unaffected.
async function askQwen(
  prompt: string,
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<LlmResult> {
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
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1000,
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
// TRIAGE AGENT (Phase 1)
// ======================================================================
//
// Classifies the complaint into a structured intent, urgency and investigation
// plan before the existing investigation runs. Additive only: the triage result
// is attached to the response for later phases and never changes the existing
// reasoning prompt, decision, refund or escalation behavior.

// >>> TRIAGE PURE LOGIC (plain JS — extracted verbatim by triage.test.mjs)
const INTENTS = [
  "DELIVERY_DELAY",
  "WRONG_PRODUCT",
  "DAMAGED_PRODUCT",
  "REFUND_REQUEST",
  "DUPLICATE_PAYMENT",
  "ORDER_STATUS",
  "UNKNOWN",
];

const URGENCIES = ["low", "normal", "high", "urgent"];

const DOMAINS = ["customer", "order", "delivery", "policy"];

// Investigation plan per intent: which evidence domains matter. This is what
// makes the plan dynamic instead of one hard-coded path for every complaint.
const INTENT_DOMAINS = {
  DELIVERY_DELAY: ["order", "delivery", "customer", "policy"],
  WRONG_PRODUCT: ["order", "customer", "policy"],
  DAMAGED_PRODUCT: ["order", "customer", "policy"],
  REFUND_REQUEST: ["order", "policy", "customer"],
  DUPLICATE_PAYMENT: ["order", "customer", "policy"],
  ORDER_STATUS: ["order", "delivery", "customer"],
  UNKNOWN: ["customer", "order"],
};

// Ordered keyword rules used by the deterministic fallback classifier. Order
// matters: more specific intents are matched before generic ones.
const INTENT_KEYWORDS = [
  [
    "DUPLICATE_PAYMENT",
    [
      "charged twice",
      "charge twice",
      "double charge",
      "duplicate payment",
      "duplicate charge",
      "two charges",
      "billed twice",
    ],
  ],
  [
    "DAMAGED_PRODUCT",
    ["damaged", "broken", "cracked", "defective", "dented", "scratch", "faulty"],
  ],
  [
    "WRONG_PRODUCT",
    [
      "wrong product",
      "wrong item",
      "wrong colour",
      "wrong color",
      "wrong model",
      "different product",
      "different item",
      "incorrect item",
      "not what i ordered",
    ],
  ],
  [
    "REFUND_REQUEST",
    ["refund", "money back", "compensation", "compensate", "reimburse"],
  ],
  [
    "DELIVERY_DELAY",
    [
      "delayed",
      "delay",
      "late",
      "not arrived",
      "hasn't arrived",
      "has not arrived",
      "still waiting",
      "not delivered",
      "still not received",
    ],
  ],
  [
    "ORDER_STATUS",
    ["status", "tracking", "track", "where is", "when will", "how long"],
  ],
];

function domainsForIntent(intent) {
  const domains = INTENT_DOMAINS[intent] || INTENT_DOMAINS.UNKNOWN;

  return domains.slice();
}

function urgencyForIntent(intent, text) {
  if (
    text.includes("urgent") ||
    text.includes("asap") ||
    text.includes("immediately")
  ) {
    return "urgent";
  }

  if (intent === "DUPLICATE_PAYMENT" || intent === "DAMAGED_PRODUCT") {
    return "high";
  }

  if (text.includes("weeks") || text.includes("still not")) {
    return "high";
  }

  return "normal";
}

// Deterministic classifier: the safe fallback when the LLM is unavailable or
// returns output that fails validation.
function classifyByKeywords(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";

  for (const [intent, keywords] of INTENT_KEYWORDS) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return {
          intent,
          urgency: urgencyForIntent(intent, text),
          domains: domainsForIntent(intent),
          reason: `Deterministic triage matched "${keyword}" for ${intent}.`,
          confidence: 0.45,
        };
      }
    }
  }

  return {
    intent: "UNKNOWN",
    urgency: "normal",
    domains: domainsForIntent("UNKNOWN"),
    reason: "No supported intent keyword matched the message.",
    confidence: 0.2,
  };
}

// Strict validation of the Triage Agent's JSON. Returns the normalized triage
// object, or null when anything is missing, out of range or unsupported.
function validateTriage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const intent =
    typeof value.intent === "string" ? value.intent.trim().toUpperCase() : "";

  if (!INTENTS.includes(intent)) {
    return null;
  }

  const urgency =
    typeof value.urgency === "string" ? value.urgency.trim().toLowerCase() : "";

  if (!URGENCIES.includes(urgency)) {
    return null;
  }

  if (!Array.isArray(value.domains)) {
    return null;
  }

  const domains = [];

  for (const entry of value.domains) {
    if (typeof entry !== "string") {
      return null;
    }

    const domain = entry.trim().toLowerCase();

    if (!DOMAINS.includes(domain)) {
      return null;
    }

    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }

  if (domains.length === 0) {
    return null;
  }

  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    return null;
  }

  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) {
    return null;
  }

  if (value.confidence < 0 || value.confidence > 1) {
    return null;
  }

  return {
    intent,
    urgency,
    domains,
    reason: value.reason.trim(),
    confidence: value.confidence,
  };
}

function buildTriagePrompt(message) {
  return `You are ResolveAI's Triage Agent. Classify one customer support request BEFORE any investigation happens.

CUSTOMER MESSAGE:
${message}

Return ONLY valid JSON in this exact structure:
{
  "intent": "ORDER_STATUS",
  "urgency": "normal",
  "domains": ["order", "delivery", "customer"],
  "reason": "Customer asks where their order is",
  "confidence": 0.9
}

Rules:
- "intent" MUST be exactly one of: DELIVERY_DELAY, WRONG_PRODUCT, DAMAGED_PRODUCT, REFUND_REQUEST, DUPLICATE_PAYMENT, ORDER_STATUS, UNKNOWN
- "urgency" MUST be exactly one of: low, normal, high, urgent
- "domains" MUST be a non-empty array containing only: customer, order, delivery, policy
- Choose ONLY the domains that are actually relevant to the classified intent.
- "reason" MUST be a short one-sentence explanation of the classification.
- "confidence" MUST be a number between 0 and 1.
- Use UNKNOWN only when no supported intent fits the message.
- Do not include markdown, explanations outside the JSON, or code fences.
`;
}
// <<< TRIAGE PURE LOGIC

// Runs the Triage Agent: LLM classification validated against the strict schema,
// falling back to the deterministic classifier so triage can never break the
// customer flow.
async function runTriage(
  message: string,
): Promise<{ triage: TriageResult; source: string }> {
  try {
    const result = await askQwen(buildTriagePrompt(message), { maxTokens: 250 });

    if (result.status === "success") {
      const validated = validateTriage(result.response);

      if (validated) {
        return { triage: validated, source: "llm" };
      }

      console.error("triage output failed validation", result.response);
    } else {
      console.error("triage LLM unavailable", result.message);
    }
  } catch (error) {
    console.error("triage error", error);
  }

  return { triage: classifyByKeywords(message), source: "fallback" };
}

// ======================================================================
// INVESTIGATION PLANNER + DOMAIN EXECUTOR (Phase 2A)
// ======================================================================
//
// Turns the Triage Agent's plan into actual domain investigations. Only the
// requested domains are executed, independent domains run in parallel, and a
// failing domain degrades safely instead of breaking the customer request.
//
// The assembled investigation keeps the legacy shape
// ({ customer, order, ticket_history, policy, customer_id }) so the existing
// reasoning prompt and decision behavior stay unchanged.

// >>> PLANNER PURE LOGIC (plain JS — extracted verbatim by planner.test.mjs)
// Stable plan order used for execution, logs and the response payload. Every
// supported domain must appear here (DOMAINS is the validation allowlist).
const PLAN_ORDER = ["order", "delivery", "customer", "policy"];

// Safe default when a plan cannot be trusted (mirrors the pre-Phase-2A
// investigation, which always fetched order + customer + policy).
const DEFAULT_PLAN = ["order", "customer", "policy"];

// Normalizes the Triage plan into the domains that will actually be executed.
//
// The validated INTENT is authoritative: each intent has a canonical domain set
// (INTENT_DOMAINS), which is what keeps existing decisions stable. The model's
// own `domains` array is advisory and is unioned in, so triage's output is used
// without letting an overly narrow model selection drop required evidence
// (e.g. dropping `policy` from a refund request). Falls back to DEFAULT_PLAN
// when nothing usable is present, and never invents an unsupported domain.
function planFromTriage(triage) {
  const wanted = [];

  const add = (entry) => {
    if (typeof entry !== "string") return;

    const domain = entry.trim().toLowerCase();

    if (!DOMAINS.includes(domain)) return;
    if (!wanted.includes(domain)) wanted.push(domain);
  };

  const intent =
    triage && typeof triage.intent === "string"
      ? triage.intent.trim().toUpperCase()
      : "";

  const canonical = INTENT_DOMAINS[intent];

  if (Array.isArray(canonical)) canonical.forEach(add);

  if (triage && Array.isArray(triage.domains)) triage.domains.forEach(add);

  if (wanted.length === 0) return DEFAULT_PLAN.slice();

  return PLAN_ORDER.filter((domain) => wanted.includes(domain));
}

// Delivery view of an order row. Derived only from stored fields — nothing is
// inferred or invented.
function deliverySnapshot(order) {
  if (!order || typeof order !== "object" || Array.isArray(order)) return null;

  const days =
    typeof order.delivery_days_delayed === "number"
      ? order.delivery_days_delayed
      : null;

  return {
    status: typeof order.status === "string" ? order.status : null,
    shipping_type:
      typeof order.shipping_type === "string" ? order.shipping_type : null,
    expected_delivery:
      typeof order.expected_delivery === "string"
        ? order.expected_delivery
        : null,
    actual_delivery:
      typeof order.actual_delivery === "string" ? order.actual_delivery : null,
    delivery_days_delayed: days,
    delayed: days !== null && days > 0,
    delivered: order.status === "delivered",
  };
}

function domainResult(domain, status, data) {
  return { domain, status, data: data === undefined ? null : data };
}

// Assembles the legacy investigation object from executed domain results only.
// A domain that was not requested, was not found, or failed is simply absent
// (null / empty array) — never substituted with other data.
function buildInvestigation(results) {
  const byDomain = {};

  for (const result of results) {
    byDomain[result.domain] = result;
  }

  const completed = (domain) => {
    const result = byDomain[domain];

    return result && result.status === "completed" ? result.data : null;
  };

  const orderData = completed("order");
  const order =
    orderData && typeof orderData === "object" && !Array.isArray(orderData)
      ? orderData
      : null;

  const customerData = completed("customer");
  const customer =
    customerData && customerData.customer && typeof customerData.customer === "object"
      ? customerData.customer
      : null;
  const tickets =
    customerData && Array.isArray(customerData.tickets)
      ? customerData.tickets
      : [];

  const policyData = completed("policy");

  // customer_id comes from the order owner first (legacy behavior); the customer
  // domain can supply it when the order domain was not requested.
  let customerId = order && typeof order.customer_id === "string"
    ? order.customer_id
    : null;

  if (
    !customerId &&
    customerData &&
    typeof customerData.customer_id === "string"
  ) {
    customerId = customerData.customer_id;
  }

  return {
    customer,
    order,
    ticket_history: tickets,
    policy: policyData && typeof policyData === "object" ? policyData : null,
    customer_id: customerId,
  };
}
// <<< PLANNER PURE LOGIC

// Loads the requested order row once. A query error is logged and treated as
// "order not available" so a database hiccup degrades instead of failing the
// whole customer request.
async function resolveOrderRow(
  supabase: SupabaseClient,
  orderId: string,
): Promise<JsonObject | null> {
  const orderRes = await supabase
    .from("orders")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderRes.error) {
    console.error("planner order query error", orderRes.error);

    return null;
  }

  return (orderRes.data as JsonObject) ?? null;
}

// Executes ONE domain. Never throws: failures are reported as a domain result so
// the rest of the plan still runs.
async function executeDomain(
  supabase: SupabaseClient,
  domain: string,
  orderId: string,
  orderRow: JsonObject | null,
): Promise<DomainResult> {
  try {
    if (domain === "order") {
      return orderRow
        ? domainResult("order", "completed", orderRow)
        : domainResult("order", "not_found", null);
    }

    if (domain === "delivery") {
      const snapshot = deliverySnapshot(orderRow);

      return snapshot
        ? domainResult("delivery", "completed", snapshot)
        : domainResult("delivery", "not_found", null);
    }

    if (domain === "customer") {
      const customerId =
        orderRow && typeof orderRow.customer_id === "string"
          ? orderRow.customer_id
          : null;

      if (!customerId) {
        return domainResult("customer", "not_found", null);
      }

      const [customerRes, ticketsRes] = await Promise.all([
        supabase
          .from("customers")
          .select("*")
          .eq("customer_id", customerId)
          .maybeSingle(),
        supabase
          .from("tickets")
          .select("*")
          .eq("customer_id", customerId)
          .order("created_date", { ascending: true }),
      ]);

      if (customerRes.error) throw new Error(customerRes.error.message);
      if (ticketsRes.error) throw new Error(ticketsRes.error.message);

      return domainResult("customer", "completed", {
        customer_id: customerId,
        customer: (customerRes.data as JsonObject) ?? null,
        tickets: (ticketsRes.data as JsonObject[]) ?? [],
      });
    }

    if (domain === "policy") {
      const policyRes = await supabase
        .from("policies")
        .select("*")
        .eq("policy_type", "delivery_refund")
        .order("policy_id", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (policyRes.error) throw new Error(policyRes.error.message);

      return policyRes.data
        ? domainResult("policy", "completed", policyRes.data)
        : domainResult("policy", "not_found", null);
    }

    return domainResult(domain, "unsupported", null);
  } catch (error) {
    console.error(`domain investigation failed: ${domain}`, error);

    return domainResult(domain, "failed", null);
  }
}

// Runs the dynamic plan: only the requested domains, in parallel, reusing the
// existing queries. Returns the plan, the per-domain results and the assembled
// investigation.
async function runInvestigationPlan(
  supabase: SupabaseClient,
  orderId: string,
  triage: { intent?: string; domains?: string[] },
  orderRow: JsonObject | null,
): Promise<{
  plan: string[];
  results: DomainResult[];
  investigation: Investigation;
}> {
  const plan = planFromTriage(triage);

  const results = await Promise.all(
    plan.map((domain) => executeDomain(supabase, domain, orderId, orderRow)),
  );

  return { plan, results, investigation: buildInvestigation(results) };
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

    // Step 0: Triage Agent — classify the complaint and produce the
    // investigation plan. Triage can never block the pipeline: on any failure it
    // falls back to deterministic classification. Its output is small, so the
    // call uses a short token cap to stay fast.
    //
    // The order row is fetched in parallel with triage (every plan needs it), so
    // the database round-trip is hidden behind the model call.
    const [triageRun, orderRow] = await Promise.all([
      runTriage(message),
      resolveOrderRow(supabase, orderId),
    ]);

    const triage = triageRun.triage;
    const triageSource = triageRun.source;

    // Step 1: Dynamic Investigation Plan — execute ONLY the domains triage
    // requested. Independent domains run in parallel and a failing domain
    // degrades safely instead of breaking the request.
    const planRun = await runInvestigationPlan(
      supabase,
      orderId,
      triage,
      orderRow,
    );

    const investigation = planRun.investigation;

    // Step 2: build the Qwen reasoning prompt (unchanged)
    const qwenPrompt = buildQwenPrompt(message, investigation);

    // Step 3: ask Qwen to reason about the case (unchanged)
    const qwenResult = await askQwen(qwenPrompt);

    console.log(
      "triage",
      JSON.stringify({ case_id: caseId, ...triage, source: triageSource }),
    );

    console.log(
      "investigation_plan",
      JSON.stringify({
        case_id: caseId,
        plan: planRun.plan,
        results: planRun.results.map((result) => ({
          domain: result.domain,
          status: result.status,
        })),
      }),
    );

    // Every successful response carries the triage result and the executed plan
    // (additive; existing keys and values are unchanged).
    const respond = (payload: JsonObject) =>
      json({
        ...payload,
        triage,
        triage_source: triageSource,
        investigation_plan: {
          domains: planRun.plan,
          results: planRun.results.map((result) => ({
            domain: result.domain,
            status: result.status,
          })),
        },
      });

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

      return respond({
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

      return respond({
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

      return respond({
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

        return respond({
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

      return respond({
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

    return respond({
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