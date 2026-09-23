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
  const orderLookup = await resolveOrder(supabase, orderId);

  const { investigation } = await runInvestigationPlan(
    supabase,
    { domains: DOMAINS },
    orderLookup,
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

// Deterministic triage-intent -> policy-type mapping (Phase 12A).
//
// Only policy types that actually exist in the `policies` table are used, so the
// Policy Agent can retrieve the policy relevant to the validated intent. An
// intent with no matching policy resolves to null: the planner then does not
// require policy evidence, the Policy Agent returns not_found, and the case
// escalates safely. No policy type is ever invented.
const POLICY_TYPE_BY_INTENT = {
  DELIVERY_DELAY: "delivery_refund",
  REFUND_REQUEST: "delivery_refund",
  WRONG_PRODUCT: "wrong_product",
  DAMAGED_PRODUCT: "product_refund",
  DUPLICATE_PAYMENT: "duplicate_payment",
  ORDER_STATUS: null,
  UNKNOWN: null,
};

// The policy type applicable to a validated intent (null when none applies).
function policyTypeForIntent(intent) {
  if (typeof intent !== "string") return null;

  const type = POLICY_TYPE_BY_INTENT[intent.trim().toUpperCase()];

  return typeof type === "string" && type !== "" ? type : null;
}

function intentRequiresPolicy(intent) {
  return policyTypeForIntent(intent) !== null;
}

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
// ORDER AGENT (Phase 2C)
// ======================================================================
//
// Specialized data-investigation agent for the `order` domain. One
// responsibility: retrieve and analyse order-specific information relevant to
// the current case (order details, status, dates, product, payment/refund
// fields already present in the schema).
//
// Deterministic database calls only — no LLM is used to retrieve order data, and
// nothing is invented or inferred from missing fields.

// >>> ORDER AGENT PURE LOGIC (plain JS — extracted verbatim by order-agent.test.mjs)
const ORDER_AGENT_NAME = "order_agent";

// Builds findings strictly from the retrieved order row. Every finding is a
// direct record read, so confidence is 1.0. Missing optional fields simply
// produce no finding — they are never filled in or guessed.
//
// NOTE: the orders table stores a single `product` value (there is no line-item
// table), so multi-item orders are reported exactly as stored.
function orderFindings(order) {
  const findings = [];

  if (!order || typeof order !== "object") return findings;

  const push = (finding) => {
    findings.push({ finding, source: "orders", confidence: 1.0 });
  };

  const text = (value) => typeof value === "string" && value.trim() !== "";

  if (text(order.order_id)) push("Order ID: " + order.order_id);
  if (text(order.product)) push("Product: " + order.product);
  if (text(order.status)) push("Order status: " + order.status);
  if (text(order.order_date)) push("Order placed on " + order.order_date);
  if (text(order.expected_delivery)) {
    push("Promised delivery date: " + order.expected_delivery);
  }
  if (text(order.actual_delivery)) push("Delivered on " + order.actual_delivery);
  if (text(order.shipping_type)) {
    push("Shipping type: " + order.shipping_type);
  }

  if (typeof order.delivery_days_delayed === "number") {
    push(
      order.delivery_days_delayed > 0
        ? "Recorded delay: " + order.delivery_days_delayed + " day(s)"
        : "Recorded delay: none",
    );
  }

  if (typeof order.amount === "number") push("Order amount: " + order.amount);
  if (text(order.payment_status)) {
    push("Payment status: " + order.payment_status);
  }
  if (text(order.refund_status)) push("Refund status: " + order.refund_status);
  if (text(order.customer_id)) push("Order owner: " + order.customer_id);

  return findings;
}

// Assembles the Order Agent's structured result from an order lookup. The status
// is driven only by the query outcome:
//   completed -> order row found
//   not_found -> no order row exists
//   failed    -> the order query failed
function orderAgentResult(input) {
  const src = input || {};

  if (src.orderError) {
    return {
      agent: ORDER_AGENT_NAME,
      domain: "order",
      status: "failed",
      order: null,
      findings: [],
    };
  }

  const order =
    src.order && typeof src.order === "object" && !Array.isArray(src.order)
      ? src.order
      : null;

  if (!order) {
    return {
      agent: ORDER_AGENT_NAME,
      domain: "order",
      status: "not_found",
      order: null,
      findings: [],
    };
  }

  return {
    agent: ORDER_AGENT_NAME,
    domain: "order",
    status: "completed",
    order,
    findings: orderFindings(order),
  };
}
// <<< ORDER AGENT PURE LOGIC

// Order Agent execution. Reuses the order row the planner already fetched — one
// shared query, no duplicated database logic — and shapes it into the agent
// result. Deterministic and non-throwing: a query failure is reported as
// `failed` so the rest of the plan still runs.
function runOrderAgent(
  orderLookup: { order: JsonObject | null; error: string | null },
): JsonObject {
  return orderAgentResult({
    order: orderLookup.order,
    orderError: orderLookup.error,
  });
}

// ======================================================================
// DELIVERY AGENT (Phase 2D)
// ======================================================================
//
// Specialized data-investigation agent for the `delivery` domain. It only
// structures the delivery/shipping information that already lives on the order
// row — no new delivery fact is calculated or inferred.
//
// IMPORTANT: the delivery view itself is produced by the existing
// `deliverySnapshot()` derivation (Phase 2A), so the delivery semantics used
// across the product are preserved exactly. No second database query is issued:
// the agent reuses the shared order lookup.

// >>> DELIVERY AGENT PURE LOGIC (plain JS — extracted verbatim by delivery-agent.test.mjs)
const DELIVERY_AGENT_NAME = "delivery_agent";

// True when the snapshot carries real delivery information: any delivery text
// field, or a positive recorded delay. A row that only holds the numeric
// default (delay 0) with no status/shipping/dates counts as no delivery info.
function hasDeliveryInfo(delivery) {
  if (!delivery || typeof delivery !== "object") return false;

  const text = (value) => typeof value === "string" && value.trim() !== "";

  if (
    text(delivery.status) ||
    text(delivery.shipping_type) ||
    text(delivery.expected_delivery) ||
    text(delivery.actual_delivery)
  ) {
    return true;
  }

  return (
    typeof delivery.delivery_days_delayed === "number" &&
    delivery.delivery_days_delayed > 0
  );
}

// Builds findings strictly from the existing delivery fields. The derived flags
// (delayed / delivered) stay in the `delivery` payload but are not restated as
// findings, because they are computed from the stored delay/status fields.
function deliveryFindings(delivery) {
  const findings = [];

  if (!delivery || typeof delivery !== "object") return findings;

  const push = (finding) => {
    findings.push({ finding, source: "orders", confidence: 1.0 });
  };

  const text = (value) => typeof value === "string" && value.trim() !== "";

  if (text(delivery.status)) {
    push("Delivery status: " + delivery.status);
  }
  if (text(delivery.shipping_type)) {
    push("Shipping method: " + delivery.shipping_type);
  }
  if (text(delivery.expected_delivery)) {
    push("Promised delivery date: " + delivery.expected_delivery);
  }
  if (text(delivery.actual_delivery)) {
    push("Actual delivery date: " + delivery.actual_delivery);
  }

  if (typeof delivery.delivery_days_delayed === "number") {
    push(
      delivery.delivery_days_delayed > 0
        ? "Recorded delivery delay: " + delivery.delivery_days_delayed + " day(s)"
        : "Recorded delivery delay: none",
    );
  }

  return findings;
}

// Assembles the Delivery Agent's structured result from the shared order lookup.
//   completed -> the order carries delivery information
//   not_found -> no order, or the order carries no delivery information
//   failed    -> the shared order query failed
function deliveryAgentResult(input) {
  const src = input || {};

  if (src.orderError) {
    return {
      agent: DELIVERY_AGENT_NAME,
      domain: "delivery",
      status: "failed",
      delivery: null,
      findings: [],
    };
  }

  const snapshot = deliverySnapshot(src.order);

  if (!snapshot || !hasDeliveryInfo(snapshot)) {
    return {
      agent: DELIVERY_AGENT_NAME,
      domain: "delivery",
      status: "not_found",
      delivery: null,
      findings: [],
    };
  }

  return {
    agent: DELIVERY_AGENT_NAME,
    domain: "delivery",
    status: "completed",
    delivery: snapshot,
    findings: deliveryFindings(snapshot),
  };
}
// <<< DELIVERY AGENT PURE LOGIC

// Delivery Agent execution. Reuses the shared order lookup (no duplicate query)
// and never throws: a query failure is reported as `failed`.
function runDeliveryAgent(
  orderLookup: { order: JsonObject | null; error: string | null },
): JsonObject {
  return deliveryAgentResult({
    order: orderLookup.order,
    orderError: orderLookup.error,
  });
}

// ======================================================================
// CUSTOMER AGENT (Phase 2B)
// ======================================================================
//
// Specialized data-investigation agent for the `customer` domain. One
// responsibility: retrieve and analyse customer-specific information relevant to
// the case (profile, support history, previous interactions).
//
// Deterministic database calls only — no LLM is used to retrieve customer data.
// Every finding is derived from actually retrieved rows; nothing is inferred.

// >>> CUSTOMER AGENT PURE LOGIC (plain JS — extracted verbatim by customer-agent.test.mjs)
const CUSTOMER_AGENT_NAME = "customer_agent";

// Builds findings strictly from retrieved data. Each finding cites its source
// table and carries full confidence because it is a direct record read.
function customerFindings(customer, supportHistory) {
  const findings = [];

  if (customer && typeof customer === "object") {
    if (typeof customer.name === "string" && customer.name.trim() !== "") {
      findings.push({
        finding: "Customer name: " + customer.name,
        source: "customers",
        confidence: 1.0,
      });
    }

    if (
      typeof customer.customer_id === "string" &&
      customer.customer_id.trim() !== ""
    ) {
      findings.push({
        finding: "Customer ID: " + customer.customer_id,
        source: "customers",
        confidence: 1.0,
      });
    }

    if (
      typeof customer.membership === "string" &&
      customer.membership.trim() !== ""
    ) {
      findings.push({
        finding: "Membership tier: " + customer.membership,
        source: "customers",
        confidence: 1.0,
      });
    }

    if (typeof customer.total_orders === "number") {
      findings.push({
        finding: "Recorded total orders: " + customer.total_orders,
        source: "customers",
        confidence: 1.0,
      });
    }

    const hasEmail =
      typeof customer.email === "string" && customer.email.trim() !== "";
    const hasPhone =
      typeof customer.phone === "string" && customer.phone.trim() !== "";

    if (hasEmail || hasPhone) {
      findings.push({
        finding:
          "Contact details on file: " +
          [hasEmail ? "email" : null, hasPhone ? "phone" : null]
            .filter(Boolean)
            .join(" + "),
        source: "customers",
        confidence: 1.0,
      });
    }
  }

  if (Array.isArray(supportHistory) && supportHistory.length > 0) {
    findings.push({
      finding: "Support history contains " + supportHistory.length + " ticket(s)",
      source: "tickets",
      confidence: 1.0,
    });

    const openTickets = supportHistory.filter(function (ticket) {
      return (
        ticket &&
        typeof ticket.status === "string" &&
        ticket.status.toLowerCase() === "open"
      );
    }).length;

    if (openTickets > 0) {
      findings.push({
        finding: openTickets + " ticket(s) still open",
        source: "tickets",
        confidence: 1.0,
      });
    }

    // Most recent ticket by recorded date. Computed rather than assumed from
    // input ordering, so the agent is robust to how rows are returned.
    const dated = supportHistory.filter(function (ticket) {
      return (
        ticket &&
        typeof ticket.created_date === "string" &&
        ticket.created_date.trim() !== ""
      );
    });

    if (dated.length > 0) {
      let latest = dated[0];

      for (const ticket of dated) {
        if (ticket.created_date > latest.created_date) latest = ticket;
      }

      findings.push({
        finding: "Most recent ticket dated " + latest.created_date,
        source: "tickets",
        confidence: 1.0,
      });
    }
  } else if (Array.isArray(supportHistory)) {
    findings.push({
      finding: "No support history recorded for this customer",
      source: "tickets",
      confidence: 1.0,
    });
  }

  return findings;
}

// Assembles the Customer Agent's structured result. Deterministic: the status is
// driven only by the query outcome flags and the retrieved row.
//   completed -> customer row found
//   not_found -> no customer row (or no customer to look up)
//   failed    -> a database/query error
function customerAgentResult(input) {
  const src = input || {};

  const failed = Boolean(src.customerError || src.ticketsError);

  const customer =
    src.customer && typeof src.customer === "object" && !Array.isArray(src.customer)
      ? src.customer
      : null;

  const history = Array.isArray(src.supportHistory) ? src.supportHistory : [];

  if (failed) {
    return {
      agent: CUSTOMER_AGENT_NAME,
      domain: "customer",
      status: "failed",
      customer: null,
      support_history: [],
      findings: [],
    };
  }

  if (!customer) {
    return {
      agent: CUSTOMER_AGENT_NAME,
      domain: "customer",
      status: "not_found",
      customer: null,
      support_history: [],
      findings: [],
    };
  }

  return {
    agent: CUSTOMER_AGENT_NAME,
    domain: "customer",
    status: "completed",
    customer,
    support_history: history,
    findings: customerFindings(customer, history),
  };
}
// <<< CUSTOMER AGENT PURE LOGIC

// Customer Agent execution: the deterministic database calls. Never throws — a
// query failure is reported as `failed` so the rest of the plan still runs.
async function runCustomerAgent(
  supabase: SupabaseClient,
  customerId: string | null,
): Promise<JsonObject> {
  if (!customerId) {
    return customerAgentResult({ customer: null, supportHistory: [] });
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

  return customerAgentResult({
    customerError: customerRes.error ? customerRes.error.message : null,
    ticketsError: ticketsRes.error ? ticketsRes.error.message : null,
    customer: (customerRes.data as JsonObject) ?? null,
    supportHistory: (ticketsRes.data as JsonObject[]) ?? [],
  });
}

// ======================================================================
// POLICY AGENT (Phase 2E)
// ======================================================================
//
// Specialized retrieval agent for the `policy` domain. It retrieves the
// applicable support policy and structures the policy data that is already
// stored in the database.
//
// RETRIEVAL ONLY: this agent never decides eligibility. Whether a case satisfies
// a policy is still evaluated downstream by the existing reasoning/decision
// stage — the agent only reports what the policy record says.
//
// Matching behavior is unchanged: the applicable policy is the first
// `delivery_refund` policy ordered by policy_id, exactly as before.

// >>> POLICY AGENT PURE LOGIC (plain JS — extracted verbatim by policy-agent.test.mjs)
const POLICY_AGENT_NAME = "policy_agent";

// Default policy type, used when no intent context is supplied (the legacy
// compatibility path). Unchanged behaviour.
const APPLICABLE_POLICY_TYPE = "delivery_refund";

// Builds findings strictly from the stored policy record. Conditions are
// reported verbatim as stored rules — they are never evaluated here.
function policyFindings(policy) {
  const findings = [];

  if (!policy || typeof policy !== "object") return findings;

  const push = (finding) => {
    findings.push({ finding, source: "policies", confidence: 1.0 });
  };

  const text = (value) => typeof value === "string" && value.trim() !== "";

  if (text(policy.title)) push("Policy: " + policy.title);
  if (text(policy.policy_type)) push("Policy type: " + policy.policy_type);
  if (text(policy.action)) push("Policy action: " + policy.action);

  if (typeof policy.policy_id === "number") {
    push("Policy ID: " + policy.policy_id);
  }

  if (Array.isArray(policy.conditions)) {
    const conditions = policy.conditions.filter(function (condition) {
      return typeof condition === "string" && condition.trim() !== "";
    });

    if (conditions.length === 0) {
      push("No eligibility conditions recorded for this policy");
    }

    for (const condition of conditions) {
      push("Condition: " + condition);
    }
  }

  return findings;
}

// Assembles the Policy Agent's structured result.
//   completed -> an applicable policy was retrieved
//   not_found -> no applicable policy exists
//   failed    -> the policy query failed
function policyAgentResult(input) {
  const src = input || {};

  if (src.policyError) {
    return {
      agent: POLICY_AGENT_NAME,
      domain: "policy",
      status: "failed",
      policy: null,
      findings: [],
    };
  }

  const policy =
    src.policy && typeof src.policy === "object" && !Array.isArray(src.policy)
      ? src.policy
      : null;

  if (!policy) {
    return {
      agent: POLICY_AGENT_NAME,
      domain: "policy",
      status: "not_found",
      policy: null,
      findings: [],
    };
  }

  return {
    agent: POLICY_AGENT_NAME,
    domain: "policy",
    status: "completed",
    policy,
    findings: policyFindings(policy),
  };
}
// <<< POLICY AGENT PURE LOGIC

// Policy Agent execution: the existing applicable-policy query, unchanged. Never
// throws — a query failure is reported as `failed` so the rest of the plan runs.
async function runPolicyAgent(
  supabase: SupabaseClient,
  policyType?: string | null,
): Promise<JsonObject> {
  // The caller supplies the policy type derived from the validated intent; an
  // explicit empty value means "no applicable policy" and returns not_found.
  const resolvedType =
    policyType === undefined
      ? APPLICABLE_POLICY_TYPE
      : typeof policyType === "string" && policyType.trim() !== ""
        ? policyType.trim()
        : null;

  if (resolvedType === null) {
    return policyAgentResult({ policy: null });
  }

  const policyRes = await supabase
    .from("policies")
    .select("*")
    .eq("policy_type", resolvedType)
    .order("policy_id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return policyAgentResult({
    policyError: policyRes.error ? policyRes.error.message : null,
    policy: (policyRes.data as JsonObject) ?? null,
  });
}

// ======================================================================
// EVIDENCE ENGINE (Phase 3)
// ======================================================================
//
// Aggregation layer between the specialized agents and the reasoning stage. It
// answers exactly one question: "which facts did the investigation agents
// return, and where did each fact come from?"
//
// It is NOT a decision maker: no LLM, no policy interpretation, no conflict
// resolution, no new business rules, no reinterpretation of agent findings.
// Every evidence item is copied verbatim from an agent's findings, keeping its
// source and confidence exactly as supplied.

// >>> EVIDENCE ENGINE PURE LOGIC (plain JS — extracted verbatim by evidence-engine.test.mjs)
// The agents whose results this engine understands. Taken from the agents' own
// name constants so the contract cannot silently drift.
const SUPPORTED_AGENTS = [
  ORDER_AGENT_NAME,
  DELIVERY_AGENT_NAME,
  CUSTOMER_AGENT_NAME,
  POLICY_AGENT_NAME,
];

// Deterministic evidence id: EV-001, EV-002, ... (never a random UUID).
function evidenceId(index) {
  return "EV-" + String(index + 1).padStart(3, "0");
}

// Normalizes ONE agent result into evidence items (0..n). Anything unsupported,
// malformed, non-completed, or without findings yields no evidence.
function evidenceFromAgentResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];

  if (typeof result.agent !== "string" || !SUPPORTED_AGENTS.includes(result.agent)) {
    return [];
  }

  if (result.status !== "completed") return [];
  if (typeof result.domain !== "string" || result.domain.trim() === "") return [];
  if (!Array.isArray(result.findings)) return [];

  const items = [];

  for (const finding of result.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    if (typeof finding.finding !== "string" || finding.finding.trim() === "") continue;
    if (typeof finding.source !== "string" || finding.source.trim() === "") continue;
    if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence)) {
      continue;
    }

    items.push({
      agent: result.agent,
      domain: result.domain,
      finding: finding.finding,
      source: finding.source,
      confidence: finding.confidence,
    });
  }

  return items;
}

// Exact-match dedupe key: all five evidence fields must be identical. Similar
// findings, or the same finding from a different source, are never merged.
function evidenceKey(item) {
  return JSON.stringify([
    item.agent,
    item.domain,
    item.finding,
    item.source,
    item.confidence,
  ]);
}

// buildEvidence(agentResults) -> { evidence, agent_status }
//
// Deterministic: results are consumed in the order the planner produced them,
// findings in their stored order, and the first occurrence wins on duplicates.
// The input is never mutated.
function buildEvidence(agentResults) {
  const results = Array.isArray(agentResults) ? agentResults : [];

  const collected = [];
  const seen = new Set();
  const agentStatus = {};

  for (const result of results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;

    const agent = typeof result.agent === "string" ? result.agent : null;

    if (!agent || !SUPPORTED_AGENTS.includes(agent)) continue;

    // Compact status summary for future conflict/uncertainty detection. Only
    // agents that actually reported are recorded — never invented.
    if (typeof result.status === "string") agentStatus[agent] = result.status;

    for (const item of evidenceFromAgentResult(result)) {
      const key = evidenceKey(item);

      if (seen.has(key)) continue;

      seen.add(key);
      collected.push(item);
    }
  }

  const evidence = collected.map(function (item, index) {
    return {
      id: evidenceId(index),
      agent: item.agent,
      domain: item.domain,
      finding: item.finding,
      source: item.source,
      confidence: item.confidence,
    };
  });

  return { evidence, agent_status: agentStatus };
}
// <<< EVIDENCE ENGINE PURE LOGIC

// ======================================================================
// CONFLICT & UNCERTAINTY ENGINE (Phase 4)
// ======================================================================
//
// Deterministic DETECTION ONLY. It reads the Evidence Engine output and reports
// whether the collected evidence is internally contradictory or insufficient.
//
// It never decides the customer-support outcome: no LLM, no database queries, no
// policy interpretation, no new business rules. It answers only: "is this
// evidence set contradictory, and is anything required missing?"

// >>> CONFLICT ENGINE PURE LOGIC (plain JS — extracted verbatim by conflict-engine.test.mjs)
// Evidence below this confidence is treated as not safely usable.
const CONFIDENCE_THRESHOLD = 0.5;

// Only single-valued factual dimensions are compared, so unrelated facts are
// never mistaken for contradictions. (A list-valued field such as the policy
// `Condition: …` entries is deliberately excluded.) Extend this map to cover
// new single-valued dimensions.
const SINGLE_VALUED_DIMENSIONS = {
  "delivery status": { type: "delivery_status_conflict", domain: "delivery" },
  "order status": { type: "order_status_conflict", domain: "order" },
  "payment status": { type: "payment_status_conflict", domain: "order" },
  "refund status": { type: "refund_status_conflict", domain: "order" },
};

// Uncertainty types that mean the evidence may be insufficient for a safe
// investigation (used for the re-investigation flag; the loop itself is a later
// phase).
const REINVESTIGATION_TRIGGERS = [
  "agent_failure",
  "agent_not_found",
  "missing_domain",
  "low_confidence",
];

function agentForDomain(domain) {
  return domain + "_agent";
}

function domainLabel(domain) {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

// Splits a stored finding into its factual dimension and value. Findings that do
// not follow the "Dimension: value" shape are ignored (never guessed at).
function splitFinding(text) {
  if (typeof text !== "string") return null;

  const index = text.indexOf(": ");

  if (index === -1) return null;

  const label = text.slice(0, index).trim();
  const value = text.slice(index + 2).trim();

  if (label === "" || value === "") return null;

  return { label, value };
}

// Contradictions: the same single-valued dimension carrying different values.
// Different dimensions, or one dimension with a single consistent value, are
// never conflicts. Evidence ids always come from the real evidence items.
function detectConflicts(evidence) {
  const dimensions = {};
  const conflicts = [];

  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const parts = splitFinding(item.finding);

    if (!parts) continue;

    const key = parts.label.toLowerCase();
    const dimension = SINGLE_VALUED_DIMENSIONS[key];

    if (!dimension) continue;

    if (!dimensions[key]) {
      dimensions[key] = { label: parts.label, dimension, values: {}, order: [] };
    }

    const entry = dimensions[key];
    const valueKey = parts.value.toLowerCase();

    if (!entry.values[valueKey]) {
      entry.values[valueKey] = { ids: [] };
      entry.order.push(valueKey);
    }

    if (typeof item.id === "string" && !entry.values[valueKey].ids.includes(item.id)) {
      entry.values[valueKey].ids.push(item.id);
    }
  }

  for (const key of Object.keys(dimensions)) {
    const entry = dimensions[key];

    // A single distinct value is consistent — not a conflict.
    if (entry.order.length < 2) continue;

    const evidenceIds = [];

    for (const valueKey of entry.order) {
      for (const id of entry.values[valueKey].ids) {
        if (!evidenceIds.includes(id)) evidenceIds.push(id);
      }
    }

    conflicts.push({
      type: entry.dimension.type,
      domain: entry.dimension.domain,
      evidence_ids: evidenceIds,
      description: "Conflicting " + entry.label.toLowerCase() + " evidence",
    });
  }

  return conflicts;
}

// Uncertainty: a required domain whose evidence is missing, unusable, or not
// confidently established. Only domains required by the current plan are
// considered — an unused agent's failure does not make the case incomplete.
function detectUncertainties(evidence, agentStatus, requiredDomains) {
  const uncertainties = [];
  const missingDomains = [];
  const status =
    agentStatus && typeof agentStatus === "object" && !Array.isArray(agentStatus)
      ? agentStatus
      : {};
  const domains = Array.isArray(requiredDomains) ? requiredDomains : [];

  for (const rawDomain of domains) {
    if (typeof rawDomain !== "string" || rawDomain.trim() === "") continue;

    const domain = rawDomain.trim().toLowerCase();
    const agent = agentForDomain(domain);
    const label = domainLabel(domain);
    const agentState = typeof status[agent] === "string" ? status[agent] : null;
    const items = evidence.filter(function (item) {
      return item && typeof item === "object" && item.domain === domain;
    });

    const markMissing = function () {
      if (!missingDomains.includes(domain)) missingDomains.push(domain);
    };

    if (agentState === "failed") {
      uncertainties.push({
        type: "agent_failure",
        agent,
        description: label + " evidence unavailable because the " + domain + " agent failed",
      });
      markMissing();
      continue;
    }

    if (agentState === "not_found") {
      uncertainties.push({
        type: "agent_not_found",
        agent,
        description: label + " evidence unavailable because the " + domain + " agent found no matching record",
      });
      markMissing();
      continue;
    }

    if (items.length === 0) {
      uncertainties.push({
        type: "missing_domain",
        domain,
        description: label + " evidence is unavailable",
      });
      markMissing();
      continue;
    }

    const weak = items.filter(function (item) {
      return typeof item.confidence === "number" && item.confidence < CONFIDENCE_THRESHOLD;
    });

    if (weak.length > 0) {
      uncertainties.push({
        type: "low_confidence",
        domain,
        evidence_ids: weak
          .map(function (item) {
            return item.id;
          })
          .filter(function (id) {
            return typeof id === "string";
          }),
        description: label + " evidence is below the confidence threshold",
      });
    }
  }

  return { uncertainties, missingDomains };
}

// analyzeEvidence(evidence, agentStatus, requiredDomains) -> investigation health
//
// Pure, deterministic and non-throwing: malformed input is ignored, the input is
// never mutated, and the same ordered input always yields the same output.
function analyzeEvidence(evidence, agentStatus, requiredDomains) {
  const items = Array.isArray(evidence) ? evidence : [];

  const conflicts = detectConflicts(items);
  const { uncertainties, missingDomains } = detectUncertainties(
    items,
    agentStatus,
    requiredDomains,
  );

  const needsReinvestigation =
    conflicts.length > 0 ||
    uncertainties.some(function (uncertainty) {
      return REINVESTIGATION_TRIGGERS.includes(uncertainty.type);
    });

  return {
    conflict_status: conflicts.length > 0 ? "detected" : "none",
    uncertainty_status: uncertainties.length > 0 ? "detected" : "none",
    requires_reinvestigation: needsReinvestigation,
    conflicts,
    uncertainties,
    missing_domains: missingDomains,
  };
}
// <<< CONFLICT ENGINE PURE LOGIC

// ======================================================================
// RE-INVESTIGATION LOOP (Phase 5)
// ======================================================================
//
// A bounded, deterministic controller that reacts to the Conflict & Uncertainty
// Engine. It re-runs ONLY the domains responsible for a conflict or uncertainty,
// through the existing domain executor, rebuilds evidence with the Evidence
// Engine, and re-checks health.
//
// No LLM calls, no new business rules, no unbounded loop. The domain execution
// is injected through `step`, so the loop logic itself is pure and testable.

// >>> REINVESTIGATION PURE LOGIC (plain JS — extracted verbatim by reinvestigation.test.mjs)
const MAX_REINVESTIGATION_ROUNDS = 2;

// Deterministic target selection from the conflict/uncertainty output. Only
// supported planner domains are ever targeted; anything unmappable is dropped.
function selectReinvestigationTargets(health) {
  const wanted = [];

  const add = (candidate) => {
    if (typeof candidate !== "string") return;

    const domain = candidate.trim().toLowerCase();

    if (!PLAN_ORDER.includes(domain)) return;
    if (!wanted.includes(domain)) wanted.push(domain);
  };

  if (!health || typeof health !== "object") return wanted;

  if (Array.isArray(health.conflicts)) {
    for (const conflict of health.conflicts) {
      if (conflict && typeof conflict === "object") add(conflict.domain);
    }
  }

  if (Array.isArray(health.uncertainties)) {
    for (const uncertainty of health.uncertainties) {
      if (!uncertainty || typeof uncertainty !== "object") continue;

      if (typeof uncertainty.domain === "string") {
        add(uncertainty.domain);
      } else if (typeof uncertainty.agent === "string") {
        add(uncertainty.agent.replace(/_agent$/, ""));
      }
    }
  }

  return PLAN_ORDER.filter((domain) => wanted.includes(domain));
}

// Deterministic signature of the investigation state (normalized evidence plus
// agent statuses). Used to detect that a round produced no change at all.
function investigationSignature(evidence, agentStatus) {
  const items = Array.isArray(evidence)
    ? evidence.map((item) => [
        item && item.agent,
        item && item.domain,
        item && item.finding,
        item && item.source,
        item && item.confidence,
      ])
    : [];

  const statuses =
    agentStatus && typeof agentStatus === "object" && !Array.isArray(agentStatus)
      ? Object.keys(agentStatus)
          .sort()
          .map((agent) => [agent, agentStatus[agent]])
      : [];

  return JSON.stringify([items, statuses]);
}

// Merges re-run domain results over the previous ones: non-target domains keep
// their earlier results and the merged list keeps plan order.
function mergeDomainResults(previousResults, newResults, plan) {
  const merged = {};

  for (const result of Array.isArray(previousResults) ? previousResults : []) {
    if (result && typeof result === "object" && typeof result.domain === "string") {
      merged[result.domain] = result;
    }
  }

  for (const result of Array.isArray(newResults) ? newResults : []) {
    if (result && typeof result === "object" && typeof result.domain === "string") {
      merged[result.domain] = result;
    }
  }

  const order = Array.isArray(plan) ? plan : Object.keys(merged);
  const ordered = [];

  for (const domain of order) {
    if (merged[domain]) ordered.push(merged[domain]);
  }

  return ordered;
}

// Deterministic outcome of one round.
function reinvestmentRoundOutcome(input) {
  const before = input.before;
  const after = input.after;
  const healthyNow =
    after.conflict_status === "none" && after.uncertainty_status === "none";

  if (healthyNow) {
    return {
      stop: true,
      resolved: true,
      stop_reason:
        before.conflict_status === "detected"
          ? "conflict_resolved"
          : "uncertainty_resolved",
    };
  }

  if (!input.changed) {
    return { stop: true, resolved: false, stop_reason: "no_change" };
  }

  if (input.round >= input.maxRounds) {
    return { stop: true, resolved: false, stop_reason: "max_rounds_reached" };
  }

  return { stop: false, resolved: false, stop_reason: null };
}

// The bounded loop. `step(domains)` performs the actual domain execution (the
// production caller injects the existing executor); the loop itself is pure.
async function runReinvestmentLoop(input) {
  const src = input || {};
  const plan = Array.isArray(src.plan) ? src.plan : [];
  const maxRounds =
    typeof src.maxRounds === "number" ? src.maxRounds : MAX_REINVESTIGATION_ROUNDS;
  const step = typeof src.step === "function" ? src.step : null;

  let results = Array.isArray(src.results) ? src.results : [];
  let evidence = Array.isArray(src.evidence) ? src.evidence : [];
  let agentStatus =
    src.agentStatus && typeof src.agentStatus === "object" && !Array.isArray(src.agentStatus)
      ? src.agentStatus
      : {};
  let health =
    src.health && typeof src.health === "object" && !Array.isArray(src.health)
      ? src.health
      : {
          conflict_status: "none",
          uncertainty_status: "none",
          requires_reinvestigation: false,
          conflicts: [],
          uncertainties: [],
          missing_domains: [],
        };

  // Round 0 is always preserved: the initial investigation is never overwritten.
  const history = [{ round: 0, type: "initial", evidence }];
  const rounds = [];
  const targetDomains = [];

  const buildSummary = (performed, roundCount, resolved, stopReason) => ({
    performed,
    rounds: roundCount,
    max_rounds: maxRounds,
    target_domains: targetDomains.slice(),
    resolved,
    stop_reason: stopReason,
  });

  if (!health.requires_reinvestigation) {
    return {
      results,
      evidence,
      agentStatus,
      health,
      history,
      rounds,
      summary: buildSummary(false, 0, true, "not_required"),
    };
  }

  const firstTargets = selectReinvestigationTargets(health);

  if (firstTargets.length === 0 || !step) {
    return {
      results,
      evidence,
      agentStatus,
      health,
      history,
      rounds,
      summary: buildSummary(false, 0, false, "no_safe_target"),
    };
  }

  let stopReason = null;
  let resolved = false;

  for (let round = 1; round <= maxRounds; round++) {
    const targets =
      round === 1 ? firstTargets : selectReinvestigationTargets(health);

    if (targets.length === 0) {
      stopReason = "no_safe_target";
      break;
    }

    for (const domain of targets) {
      if (!targetDomains.includes(domain)) targetDomains.push(domain);
    }

    const before = {
      conflict_status: health.conflict_status,
      uncertainty_status: health.uncertainty_status,
    };
    const beforeSignature = investigationSignature(evidence, agentStatus);

    const newResults = await step(targets.slice());
    results = mergeDomainResults(results, newResults, plan);

    // Evidence is always rebuilt by the Evidence Engine — never hand-crafted here.
    const rebuilt = buildEvidence(results.map((result) => result.data));
    evidence = rebuilt.evidence;
    agentStatus = rebuilt.agent_status;
    health = analyzeEvidence(evidence, agentStatus, plan);

    const after = {
      conflict_status: health.conflict_status,
      uncertainty_status: health.uncertainty_status,
    };
    const changed =
      investigationSignature(evidence, agentStatus) !== beforeSignature;
    const outcome = reinvestmentRoundOutcome({
      before,
      after,
      changed,
      round,
      maxRounds,
    });

    rounds.push({
      round,
      target_domains: targets.slice(),
      before,
      after,
      changed,
      stopped: outcome.stop,
      stop_reason: outcome.stop_reason,
    });
    history.push({
      round,
      type: "reinvestigation",
      target_domains: targets.slice(),
      evidence,
    });

    if (outcome.stop) {
      stopReason = outcome.stop_reason;
      resolved = outcome.resolved;
      break;
    }
  }

  return {
    results,
    evidence,
    agentStatus,
    health,
    history,
    rounds,
    summary: buildSummary(rounds.length > 0, rounds.length, resolved, stopReason),
  };
}
// <<< REINVESTIGATION PURE LOGIC

// ======================================================================
// DECISION GATE (Phase 6)
// ======================================================================
//
// A deterministic safety gate over the FINAL investigation state. It answers one
// question only: "is there enough reliable investigation evidence to allow the
// automated reasoning/decision path to run?"
//
// It never makes a business decision (no approve/deny/refund/escalate), performs
// no database calls, calls no LLM, mutates nothing and never throws.

// >>> DECISION GATE PURE LOGIC (plain JS — extracted verbatim by decision-gate.test.mjs)
const GATE_PROCEED = "PROCEED";
const GATE_BLOCK = "BLOCK";
const GATE_SUFFICIENT = "INVESTIGATION_SUFFICIENT";

// Agent result statuses that block the gate, with their machine-readable code.
const GATE_BLOCKING_STATUS_CODES = {
  failed: "AGENT_FAILED",
  not_found: "AGENT_NOT_FOUND",
  unsupported: "AGENT_UNSUPPORTED",
};

// evaluateDecisionGate({ plan, agentResults, evidence, investigationHealth,
//                        reinvestigation }) -> { status, reason, reasons }
//
// PROCEED only when the final plan is fully, reliably investigated. Blocking
// reasons are ordered most-specific-first (per required domain, in plan order),
// followed by the investigation-health flags, so `reason` is the primary cause.
function evaluateDecisionGate(input) {
  const src = input || {};
  const plan = Array.isArray(src.plan) ? src.plan : [];
  const agentResults = Array.isArray(src.agentResults) ? src.agentResults : [];
  const evidence = Array.isArray(src.evidence) ? src.evidence : [];
  const health =
    src.investigationHealth &&
    typeof src.investigationHealth === "object" &&
    !Array.isArray(src.investigationHealth)
      ? src.investigationHealth
      : {};
  const reinvestigation =
    src.reinvestigation &&
    typeof src.reinvestigation === "object" &&
    !Array.isArray(src.reinvestigation)
      ? src.reinvestigation
      : {};

  const reasons = [];

  const addReason = (code, extra) => {
    const reason = { code };

    if (extra && typeof extra.domain === "string") reason.domain = extra.domain;
    if (extra && typeof extra.agent === "string") reason.agent = extra.agent;

    reasons.push(reason);
  };

  // Index the final domain results by domain.
  const byDomain = {};

  for (const result of agentResults) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      if (typeof result.domain === "string") byDomain[result.domain] = result;
    }
  }

  // Per required domain (from the FINAL plan — never hard-coded).
  for (const rawDomain of plan) {
    if (typeof rawDomain !== "string" || rawDomain.trim() === "") continue;

    const domain = rawDomain.trim().toLowerCase();
    const agent = domain + "_agent";
    const result = byDomain[domain];

    if (!result) {
      addReason("REQUIRED_DOMAIN_MISSING", { domain, agent });
      continue;
    }

    const status = typeof result.status === "string" ? result.status : "";
    const blockingCode = GATE_BLOCKING_STATUS_CODES[status];

    if (blockingCode) {
      addReason(blockingCode, { domain, agent });
      continue;
    }

    if (status !== "completed") {
      addReason("AGENT_UNSUPPORTED", { domain, agent });
      continue;
    }

    // A completed domain is expected to contribute usable evidence.
    const hasEvidence = evidence.some(function (item) {
      return (
        item &&
        typeof item === "object" &&
        item.domain === domain &&
        typeof item.id === "string"
      );
    });

    if (!hasEvidence) {
      addReason("REQUIRED_EVIDENCE_MISSING", { domain, agent });
    }
  }

  // Investigation-health flags (also honour an unresolved re-investigation).
  // Ordered most-specific-first so `reason` names the actionable cause: a
  // detected conflict or uncertainty leads, and the derived "reinvestigation
  // required" signal comes last.
  if (health.conflict_status === "detected") addReason("CONFLICT_PRESENT");
  if (health.uncertainty_status === "detected") addReason("UNCERTAINTY_PRESENT");

  const reinvestigationRequired =
    health.requires_reinvestigation === true ||
    (reinvestigation.performed === true && reinvestigation.resolved === false);

  if (reinvestigationRequired) addReason("REINVESTIGATION_REQUIRED");

  if (reasons.length === 0) {
    return { status: GATE_PROCEED, reason: GATE_SUFFICIENT, reasons };
  }

  return { status: GATE_BLOCK, reason: reasons[0].code, reasons };
}
// <<< DECISION GATE PURE LOGIC

// ======================================================================
// DECISION AGENT (Phase 7)
// ======================================================================
//
// A structured, evidence-grounded decision-making layer. It proposes ONE
// business decision from the FINAL investigation state and never acts on it:
// no database writes, no refunds, no escalations, no action execution.
//
// The proposal is validated deterministically before it is accepted, and the
// Decision Gate has the final say — a blocked investigation gets no automated
// decision at all. The LLM call reuses the existing askQwen helper.

// >>> DECISION AGENT PURE LOGIC (plain JS — extracted verbatim by decision-agent.test.mjs)
const DECISION_AGENT_NAME = "decision_agent";

const DECISION_AGENT_DECISIONS = ["APPROVE", "DENY", "INFORM", "ESCALATE"];
const DECISION_AGENT_ACTIONS = [
  "REFUND_SHIPPING_FEE",
  "PRODUCT_REFUND",
  "NO_ACTION",
  "ESCALATE_TO_HUMAN",
];

// The only decision/action pairings the existing system supports.
const DECISION_ACTION_MAP = {
  APPROVE: ["REFUND_SHIPPING_FEE", "PRODUCT_REFUND"],
  DENY: ["NO_ACTION"],
  INFORM: ["NO_ACTION"],
  ESCALATE: ["ESCALATE_TO_HUMAN"],
};

// Phase 12B: which policy types may support each executable action. A policy
// that would require any other action must escalate instead — replacement and
// payment reversal remain unimplemented because the schema cannot represent
// their business state safely.
const ACTION_POLICY_SCOPE = {
  REFUND_SHIPPING_FEE: ["delivery_refund"],
  PRODUCT_REFUND: ["product_refund", "wrong_product"],
};

// Decisions that act on the customer's request without a human, so they must
// cite supporting evidence.
const EVIDENCE_REQUIRED_DECISIONS = ["APPROVE", "DENY", "INFORM"];

// A blocked investigation must never receive an automated decision.
function blockedDecisionAgentResult(gate) {
  if (gate && typeof gate === "object" && gate.status === "BLOCK") {
    return {
      agent: DECISION_AGENT_NAME,
      status: "blocked",
      reason: "DECISION_GATE_BLOCKED",
    };
  }

  return null;
}

// Maps a failed/unavailable LLM call to a deterministic failure result.
function decisionAgentLlmFailure(llmResult) {
  const result = llmResult || {};

  if (result.status === "success") return null;

  return {
    agent: DECISION_AGENT_NAME,
    status: "failed",
    reason: "LLM_UNAVAILABLE",
  };
}

// Strict, deterministic validation of the model's proposed decision. Pure: no
// database, no LLM, never throws, never mutates its input.
function validateDecisionAgentOutput(input) {
  const src = input || {};
  const output = src.output;
  const evidence = Array.isArray(src.evidence) ? src.evidence : [];
  const plan = Array.isArray(src.plan) ? src.plan : [];
  const order =
    src.order && typeof src.order === "object" && !Array.isArray(src.order)
      ? src.order
      : null;
  const gate = src.gate && typeof src.gate === "object" ? src.gate : null;

  const fail = (reason) => ({ valid: false, reason });

  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return fail("INVALID_MODEL_OUTPUT");
  }

  const decision =
    typeof output.decision === "string" ? output.decision.trim().toUpperCase() : "";

  if (!DECISION_AGENT_DECISIONS.includes(decision)) {
    return fail("INVALID_DECISION");
  }

  const action =
    typeof output.action === "string" ? output.action.trim().toUpperCase() : "";

  if (!DECISION_AGENT_ACTIONS.includes(action)) {
    return fail("INVALID_ACTION");
  }

  const allowedActions = DECISION_ACTION_MAP[decision] || [];

  if (!allowedActions.includes(action)) {
    return fail("INVALID_ACTION");
  }

  // Defence in depth: the gate also blocks automated decisions here.
  if (gate && gate.status === "BLOCK") {
    return fail("DECISION_GATE_BLOCKED");
  }

  if (
    typeof output.confidence !== "number" ||
    !Number.isFinite(output.confidence) ||
    output.confidence < 0 ||
    output.confidence > 1
  ) {
    return fail("INVALID_CONFIDENCE");
  }

  const reasoning =
    typeof output.reasoning === "string" ? output.reasoning.trim() : "";

  if (reasoning === "") {
    return fail("EMPTY_REASONING");
  }

  if (!Array.isArray(output.evidence_ids)) {
    return fail("INVALID_EVIDENCE_IDS");
  }

  const knownIds = [];

  for (const item of evidence) {
    if (item && typeof item.id === "string" && !knownIds.includes(item.id)) {
      knownIds.push(item.id);
    }
  }

  const cited = [];

  for (const rawId of output.evidence_ids) {
    if (typeof rawId !== "string" || rawId.trim() === "") {
      return fail("INVALID_EVIDENCE_IDS");
    }

    const id = rawId.trim();

    // The agent may never invent evidence.
    if (!knownIds.includes(id)) {
      return fail("UNKNOWN_EVIDENCE_ID");
    }

    if (!cited.includes(id)) cited.push(id);
  }

  if (cited.length === 0 && EVIDENCE_REQUIRED_DECISIONS.includes(decision)) {
    return fail("MISSING_EVIDENCE_IDS");
  }

  // Safety: never authorise a second refund for an order already refunded.
  if (action === "REFUND_SHIPPING_FEE" && order && order.refund_status === "initiated") {
    return fail("ACTION_ALREADY_COMPLETED");
  }

  // Safety: any action that depends on a policy (shipping-fee refund, product
  // refund) must be supported by cited policy evidence when policy is planned.
  if ((ACTION_POLICY_SCOPE[action] || []).length > 0) {
    const planRequiresPolicy = plan.some(function (domain) {
      return typeof domain === "string" && domain.trim().toLowerCase() === "policy";
    });

    if (planRequiresPolicy) {
      const policyEvidence = evidence.filter(function (item) {
        return item && typeof item === "object" && item.domain === "policy";
      });
      const citesPolicy = cited.some(function (id) {
        return policyEvidence.some(function (item) {
          return item.id === id;
        });
      });

      if (policyEvidence.length === 0 || !citesPolicy) {
        return fail("POLICY_EVIDENCE_REQUIRED");
      }
    }
  }

  return {
    valid: true,
    decision,
    action,
    confidence: output.confidence,
    reasoning,
    evidence_ids: cited,
  };
}

// Compact, structured, evidence-grounded prompt. No secrets, no raw application
// state — just the findings, their evidence ids and the investigation context.
function buildDecisionAgentPrompt(input) {
  const src = input || {};
  const evidence = Array.isArray(src.evidence) ? src.evidence : [];
  const health = src.health && typeof src.health === "object" ? src.health : {};
  const gate = src.gate && typeof src.gate === "object" ? src.gate : {};
  const plan = Array.isArray(src.plan) ? src.plan : [];
  const message = typeof src.message === "string" ? src.message : "";
  const policyType = typeof src.policyType === "string" ? src.policyType : "";

  const byDomain = {};

  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;

    const domain = typeof item.domain === "string" ? item.domain : "other";

    if (!byDomain[domain]) byDomain[domain] = [];

    byDomain[domain].push(
      "- " + item.id + " [" + domain + "] " + item.finding,
    );
  }

  const section = (title, domain) =>
    byDomain[domain] && byDomain[domain].length > 0
      ? title + ":\n" + byDomain[domain].join("\n")
      : title + ": none";

  return `You are ResolveAI's Decision Agent. Propose ONE business decision for this case.

CUSTOMER MESSAGE:
${message}

INVESTIGATION PLAN (required domains): ${plan.join(", ") || "none"}

EVIDENCE (each line is an evidence id you may cite):
${section("ORDER EVIDENCE", "order")}
${section("DELIVERY EVIDENCE", "delivery")}
${section("CUSTOMER EVIDENCE", "customer")}
${section("POLICY EVIDENCE", "policy")}

INVESTIGATION HEALTH: conflict=${health.conflict_status || "none"} uncertainty=${health.uncertainty_status || "none"}
DECISION GATE: ${gate.status || "unknown"}
RETRIEVED POLICY TYPE: ${policyType || "none"}

RULES:
- Decide ONLY from the evidence listed above. Never invent facts.
- Never invent evidence ids. Only cite ids that appear above.
- "decision" MUST be exactly one of: APPROVE, DENY, INFORM, ESCALATE
- "action" MUST be exactly one of: REFUND_SHIPPING_FEE, PRODUCT_REFUND, NO_ACTION, ESCALATE_TO_HUMAN
- Allowed pairings: APPROVE -> REFUND_SHIPPING_FEE or PRODUCT_REFUND; DENY -> NO_ACTION; INFORM -> NO_ACTION; ESCALATE -> ESCALATE_TO_HUMAN
- A refund requires policy evidence that supports it.
- Executable actions: REFUND_SHIPPING_FEE requires the retrieved policy type delivery_refund; PRODUCT_REFUND requires the retrieved policy type product_refund or wrong_product.
- Replacement, payment reversal, cancellation and any other resolution CANNOT be executed automatically: use ESCALATE for those.
- Never propose a refund for an order that is already refunded.
- If the evidence is insufficient to decide safely, use ESCALATE.
- You only propose; you never perform actions yourself.
- Return ONLY valid JSON. No markdown, no code fences, no extra text.

Return this exact JSON structure:
{
  "decision": "APPROVE",
  "action": "REFUND_SHIPPING_FEE",
  "confidence": 0.94,
  "reasoning": "short explanation grounded in the cited evidence",
  "evidence_ids": ["EV-001", "EV-004"]
}
`;
}
// <<< DECISION AGENT PURE LOGIC

// Decision Agent execution: proposes a validated decision. It performs no writes
// and executes no action; a blocked gate short-circuits before any LLM call.
async function runDecisionAgent(input: {
  gate: JsonObject;
  message: string;
  plan: string[];
  evidence: JsonObject[];
  health: JsonObject;
  order: JsonObject | null;
  policyType?: string | null;
}): Promise<JsonObject> {
  const blocked = blockedDecisionAgentResult(input.gate);

  if (blocked) return blocked;

  const llmResult = await askQwen(buildDecisionAgentPrompt(input), {
    maxTokens: 600,
  });

  const failure = decisionAgentLlmFailure(llmResult);

  if (failure) return failure;

  const validation = validateDecisionAgentOutput({
    output: llmResult.response,
    evidence: input.evidence,
    plan: input.plan,
    order: input.order,
    gate: input.gate,
  });

  if (!validation.valid) {
    return {
      agent: DECISION_AGENT_NAME,
      status: "failed",
      reason: validation.reason,
    };
  }

  return {
    agent: DECISION_AGENT_NAME,
    status: "completed",
    decision: validation.decision,
    action: validation.action,
    confidence: validation.confidence,
    reasoning: validation.reasoning,
    evidence_ids: validation.evidence_ids,
  };
}

// ======================================================================
// DECISION AUTHORITY + ACTION SAFETY GATE (Phase 8)
// ======================================================================
//
// The validated Decision Agent is the authoritative source for automated
// decisions. This layer decides whether an automated action may run at all, and
// then whether the specific action is safe — the legacy reasoning path can never
// override it.
//
// Pure and deterministic: no database writes, no LLM calls, no action
// execution, never throws, never mutates its input.

// >>> ACTION AUTHORITY PURE LOGIC (plain JS — extracted verbatim by action-authority.test.mjs)
// The authoritative vocabulary maps onto the existing legacy decision/action
// vocabulary so the existing response builders, executor and persistence are
// reused unchanged.
const LEGACY_DECISION_BY_AUTHORITY = {
  APPROVE: "approve",
  DENY: "deny",
  INFORM: "inform",
  ESCALATE: "escalate",
};

const LEGACY_ACTION_BY_AUTHORITY = {
  REFUND_SHIPPING_FEE: "refund_shipping_fee",
  PRODUCT_REFUND: "product_refund",
  NO_ACTION: "no_action",
  ESCALATE_TO_HUMAN: "human_review",
};

// Only a successfully validated Decision Agent result can authorize an action.
// Everything else blocks — and a blocked case never falls back to legacy
// reasoning for action authority.
function resolveAuthoritativeDecision(input) {
  const src = input || {};
  const gate =
    src.decisionGate && typeof src.decisionGate === "object" ? src.decisionGate : null;
  const agent =
    src.decisionAgent && typeof src.decisionAgent === "object"
      ? src.decisionAgent
      : null;
  const validation =
    src.validation && typeof src.validation === "object" ? src.validation : null;

  if (!gate || gate.status !== "PROCEED") {
    return {
      status: "blocked",
      reason:
        gate && gate.status === "BLOCK"
          ? "DECISION_GATE_BLOCKED"
          : "DECISION_GATE_NOT_PROCEED",
    };
  }

  if (!agent) return { status: "blocked", reason: "DECISION_AGENT_MISSING" };

  if (agent.status === "blocked") {
    return { status: "blocked", reason: "DECISION_AGENT_BLOCKED" };
  }

  if (agent.status === "failed") {
    return {
      status: "blocked",
      reason: typeof agent.reason === "string" ? agent.reason : "DECISION_AGENT_FAILED",
    };
  }

  if (agent.status !== "completed") {
    return { status: "blocked", reason: "DECISION_AGENT_NOT_COMPLETED" };
  }

  if (validation && validation.valid !== true) {
    return { status: "blocked", reason: "DECISION_AGENT_VALIDATION_FAILED" };
  }

  if (
    !DECISION_AGENT_DECISIONS.includes(agent.decision) ||
    !DECISION_AGENT_ACTIONS.includes(agent.action)
  ) {
    return { status: "blocked", reason: "INVALID_DECISION_AGENT_OUTPUT" };
  }

  return {
    status: "authorized",
    decision: agent.decision,
    action: agent.action,
  };
}

// Deterministic safety check before the existing action executor is called.
function validateAuthorizedAction(input) {
  const src = input || {};
  const decision =
    typeof src.decision === "string" ? src.decision.trim().toUpperCase() : "";
  const action =
    typeof src.action === "string" ? src.action.trim().toUpperCase() : "";
  const evidence = Array.isArray(src.evidence) ? src.evidence : [];
  const plan = Array.isArray(src.plan) ? src.plan : [];
  const investigation =
    src.investigation && typeof src.investigation === "object"
      ? src.investigation
      : null;
  const order =
    src.order && typeof src.order === "object" && !Array.isArray(src.order)
      ? src.order
      : investigation && investigation.order && typeof investigation.order === "object"
        ? investigation.order
        : null;
  const policyType =
    typeof src.policyType === "string" ? src.policyType.trim() : "";

  const blocked = (reason) => ({ status: "blocked", reason });

  if (!DECISION_AGENT_DECISIONS.includes(decision)) {
    return blocked("UNSUPPORTED_DECISION");
  }

  if (!DECISION_AGENT_ACTIONS.includes(action)) {
    return blocked("UNSUPPORTED_ACTION");
  }

  const allowedActions = DECISION_ACTION_MAP[decision] || [];

  if (!allowedActions.includes(action)) {
    return blocked("INVALID_DECISION_ACTION_PAIRING");
  }

  // Both refund-like actions share the same deterministic safety rules: they
  // must be supported by the applicable policy, have an order that is not
  // already refunded, and be backed by order and policy evidence.
  if (action === "REFUND_SHIPPING_FEE" || action === "PRODUCT_REFUND") {
    const policyScope = ACTION_POLICY_SCOPE[action] || [];

    if (policyType !== "" && !policyScope.includes(policyType)) {
      return blocked("UNSUPPORTED_ACTION_FOR_POLICY");
    }

    if (!order) return blocked("ORDER_MISSING");

    // Never authorise a second refund for an order that was already refunded.
    if (order.refund_status === "initiated") {
      return blocked("ACTION_ALREADY_COMPLETED");
    }

    if (evidence.length === 0) return blocked("REQUIRED_EVIDENCE_MISSING");

    const planRequiresPolicy = plan.some(function (domain) {
      return typeof domain === "string" && domain.trim().toLowerCase() === "policy";
    });

    if (planRequiresPolicy) {
      const hasPolicyEvidence = evidence.some(function (item) {
        return item && typeof item === "object" && item.domain === "policy";
      });

      if (!hasPolicyEvidence) return blocked("POLICY_EVIDENCE_MISSING");
    }
  }

  return { status: "allowed", reason: null };
}
// <<< ACTION AUTHORITY PURE LOGIC

// ======================================================================
// EXECUTION TRACE / OBSERVABILITY (Phase 9)
// ======================================================================
//
// A structured record of what ACTUALLY executed for one support case. It is
// built from real execution only: no simulated progress, no timers, no invented
// stages. It performs no LLM calls, no database queries, no action execution and
// stores no prompts or secrets.
//
// The trace is kept in memory for this phase and exposed additively in the
// response; persistent trace storage is deferred (no schema change).

// >>> EXECUTION TRACE PURE LOGIC (plain JS — extracted verbatim by execution-trace.test.mjs)
const TRACE_VERSION = 1;

const TRACE_STAGES = [
  "triage",
  "investigation_planner",
  "customer_agent",
  "order_agent",
  "delivery_agent",
  "policy_agent",
  "evidence_engine",
  "conflict_uncertainty",
  "reinvestigation",
  "decision_gate",
  "decision_agent",
  "decision_authority",
  "action_safety",
  "action_executor",
  "case_outcome",
];

const TRACE_STATUSES = ["started", "completed", "failed", "blocked", "skipped"];

// Maps a real domain-result status onto an allowed trace status. A domain that
// ran but found nothing still executed, so it is `completed` with its real
// status kept in the summary.
function traceStatusForDomain(domainStatus) {
  if (domainStatus === "failed") return "failed";

  return "completed";
}

// Safe structured summary for a domain stage (never the raw rows).
function domainStageSummary(result) {
  const data = result && typeof result === "object" ? result.data : null;
  const findings =
    data && typeof data === "object" && Array.isArray(data.findings)
      ? data.findings.length
      : 0;

  return {
    status: typeof result?.status === "string" ? result.status : "unknown",
    finding_count: findings,
  };
}

// Domain agents the plan did not require — recorded as skipped, never invented.
function missingDomainStages(plan) {
  const required = Array.isArray(plan) ? plan : [];

  return PLAN_ORDER.filter(function (domain) {
    return !required.includes(domain);
  });
}

function reinvestmentStageStatus(summary) {
  return summary && summary.performed === true ? "completed" : "skipped";
}

// Real re-investigation summary: actual rounds only, or the reason it was skipped.
function reinvestmentStageSummary(summary, rounds) {
  const safe = summary && typeof summary === "object" ? summary : {};
  const performed = safe.performed === true;

  if (!performed) {
    return { rounds: 0, reason: typeof safe.stop_reason === "string" ? safe.stop_reason : "not_required" };
  }

  const detail = (Array.isArray(rounds) ? rounds : []).map(function (round) {
    return {
      round: round && typeof round.round === "number" ? round.round : null,
      target_domains: Array.isArray(round && round.target_domains)
        ? round.target_domains.slice()
        : [],
      result: round && typeof round.stop_reason === "string" ? round.stop_reason : null,
    };
  });

  return { rounds: detail.length, rounds_detail: detail };
}

function createExecutionTrace(caseId) {
  return {
    case_id: typeof caseId === "string" ? caseId : "",
    trace_version: TRACE_VERSION,
    started_at: new Date().toISOString(),
    completed_at: null,
    stages: [],
  };
}

// Opens a stage that is really starting. Returns the entry to complete later.
function startTraceStage(trace, stage) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.stages)) return null;
  if (!TRACE_STAGES.includes(stage)) return null;

  const entry = {
    id: "trace-stage-" + String(trace.stages.length + 1).padStart(3, "0"),
    stage,
    status: "started",
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
    summary: {},
  };

  trace.stages.push(entry);

  return entry;
}

// Closes a stage with a real outcome. Duration is measured from the real
// timestamps and is never negative; if it cannot be measured it stays null.
function finishTraceStage(entry, status, summary) {
  if (!entry || typeof entry !== "object") return null;
  if (!TRACE_STATUSES.includes(status)) return null;

  const completedAt = new Date().toISOString();
  const startedMs = typeof entry.started_at === "string" ? new Date(entry.started_at).getTime() : NaN;
  const completedMs = new Date(completedAt).getTime();

  entry.status = status;
  entry.completed_at = completedAt;
  entry.duration_ms =
    Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : null;
  entry.summary = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};

  return entry;
}

function completeTraceStage(entry, summary) {
  return finishTraceStage(entry, "completed", summary);
}

function failTraceStage(entry, summary) {
  return finishTraceStage(entry, "failed", summary);
}

function blockTraceStage(entry, summary) {
  return finishTraceStage(entry, "blocked", summary);
}

// Records a stage that did not run at all (no timings — nothing happened).
function skipTraceStage(trace, stage, summary) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.stages)) return null;
  if (!TRACE_STAGES.includes(stage)) return null;

  const entry = {
    id: "trace-stage-" + String(trace.stages.length + 1).padStart(3, "0"),
    stage,
    status: "skipped",
    started_at: null,
    completed_at: null,
    duration_ms: null,
    summary: summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {},
  };

  trace.stages.push(entry);

  return entry;
}

function finishExecutionTrace(trace) {
  if (!trace || typeof trace !== "object") return null;

  trace.completed_at = new Date().toISOString();

  return trace;
}
// <<< EXECUTION TRACE PURE LOGIC

// ======================================================================
// TRACE PERSISTENCE + CASE REPLAY RETRIEVAL (Phase 10)
// ======================================================================
//
// Persists the real Phase 9 execution trace so a completed case can later be
// inspected (replayed) exactly as it happened.
//
// Replay is READ-ONLY: it returns the stored trace unchanged and never re-runs
// agents, never calls the LLM, never executes actions and never reconstructs a
// trace from current database state.
//
// The client is injected so these helpers stay pure/testable; the support
// function passes its service-role client (trace writes stay backend-only).

// >>> TRACE PERSISTENCE PURE LOGIC (plain JS — extracted verbatim by case-replay.test.mjs)
const TRACE_TABLE = "case_investigation_traces";

// Best-effort persistence: an observability write must never fail the support
// request, retry endlessly, or change the case outcome.
async function persistExecutionTrace(supabase, trace) {
  try {
    if (!supabase || typeof supabase.from !== "function") {
      return { ok: false, reason: "NO_CLIENT" };
    }

    if (
      !trace ||
      typeof trace !== "object" ||
      typeof trace.case_id !== "string" ||
      trace.case_id.trim() === "" ||
      !Array.isArray(trace.stages)
    ) {
      return { ok: false, reason: "INVALID_TRACE" };
    }

    const { error } = await supabase.from(TRACE_TABLE).insert({
      case_id: trace.case_id,
      trace_version:
        typeof trace.trace_version === "number" ? trace.trace_version : 1,
      trace,
    });

    if (error) {
      // A duplicate means this execution's trace is already stored — idempotent,
      // never overwritten.
      if (error.code === "23505") return { ok: true, reason: "ALREADY_STORED" };

      console.error("Failed to persist execution trace", error.message);

      return { ok: false, reason: "INSERT_FAILED" };
    }

    return { ok: true, reason: "STORED" };
  } catch (error) {
    console.error("Failed to persist execution trace", error);

    return { ok: false, reason: "INSERT_FAILED" };
  }
}

// Read-only retrieval of a stored trace. Returns the historical trace exactly as
// recorded; a missing case is a safe not-found, never a reconstruction.
async function getCaseExecutionTrace(supabase, caseId) {
  try {
    if (!supabase || typeof supabase.from !== "function") {
      return { status: "failed", reason: "NO_CLIENT" };
    }

    if (typeof caseId !== "string" || caseId.trim() === "") {
      return { status: "not_found", trace: null };
    }

    const { data, error } = await supabase
      .from(TRACE_TABLE)
      .select("case_id, trace_version, trace, created_at")
      .eq("case_id", caseId.trim())
      .maybeSingle();

    if (error) {
      console.error("Failed to read execution trace", error.message);

      return { status: "failed", reason: "READ_FAILED" };
    }

    if (!data || typeof data !== "object") {
      return { status: "not_found", trace: null };
    }

    return {
      status: "found",
      trace: data.trace,
      trace_version: data.trace_version,
      stored_at: data.created_at,
    };
  } catch (error) {
    console.error("Failed to read execution trace", error);

    return { status: "failed", reason: "READ_FAILED" };
  }
}
// <<< TRACE PERSISTENCE PURE LOGIC

// Read-only replay endpoint: GET /<caseId>/trace.
//
// The service-role client bypasses RLS, so authorization is enforced here, using
// the same model as the other agent-facing backend functions: a valid session
// plus an active agent/admin profile. Anonymous callers get 401; authenticated
// non-agents get 403.
async function handleTraceRetrieval(
  req: Request,
  supabase: SupabaseClient,
): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const match = pathname.match(/\/([A-Za-z0-9_-]+)\/trace\/?$/);

  if (!match) return json({ error: "Not found." }, 404);

  const caseId = decodeURIComponent(match[1]);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "").trim();

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);

  if (userError || !userData?.user) {
    return json({ error: "Authentication required." }, 401);
  }

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

  const result = await getCaseExecutionTrace(supabase, caseId);

  if (result.status === "not_found") {
    return json({ error: "No execution trace found for this case." }, 404);
  }

  if (result.status === "failed") {
    return json({ error: "Execution trace unavailable." }, 500);
  }

  return json({ case_id: caseId, execution_trace: result.trace });
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

  // Phase 12A: policy investigation is included whenever the validated intent
  // requires policy evidence. Derived from the intent->policy mapping rather
  // than hardcoded per intent, and only ever added (never removed).
  if (intentRequiresPolicy(intent) && !wanted.includes("policy")) {
    wanted.push("policy");
  }

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

  // The order domain is produced by the Order Agent (Phase 2C), whose result
  // carries the raw order row under `order`.
  const orderData = completed("order");
  const order =
    orderData &&
    orderData.order &&
    typeof orderData.order === "object" &&
    !Array.isArray(orderData.order)
      ? orderData.order
      : null;

  // The customer domain is produced by the Customer Agent (Phase 2B), whose
  // result carries `customer` + `support_history`. The legacy investigation
  // object still exposes them as `customer` + `ticket_history`.
  const customerData = completed("customer");
  const customer =
    customerData && customerData.customer && typeof customerData.customer === "object"
      ? customerData.customer
      : null;
  const tickets =
    customerData && Array.isArray(customerData.support_history)
      ? customerData.support_history
      : [];

  // The policy domain is produced by the Policy Agent (Phase 2E), whose result
  // carries the raw policy record under `policy`. The legacy investigation still
  // exposes it as the plain `policy` object expected by the reasoning prompt.
  const policyData = completed("policy");

  // customer_id comes from the order owner first (legacy behavior); the customer
  // agent result can supply it when the order domain was not requested.
  let customerId = order && typeof order.customer_id === "string"
    ? order.customer_id
    : null;

  if (
    !customerId &&
    customer &&
    typeof customer.customer_id === "string"
  ) {
    customerId = customer.customer_id;
  }

  return {
    customer,
    order,
    ticket_history: tickets,
    policy:
      policyData && policyData.policy && typeof policyData.policy === "object"
        ? policyData.policy
        : null,
    customer_id: customerId,
  };
}
// <<< PLANNER PURE LOGIC

// Loads the requested order row once. Returns the row plus the query error (if
// any), so the Order Agent can distinguish "not found" from "query failed" while
// a database hiccup still degrades instead of failing the whole request.
async function resolveOrder(
  supabase: SupabaseClient,
  orderId: string,
): Promise<{ order: JsonObject | null; error: string | null }> {
  const orderRes = await supabase
    .from("orders")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderRes.error) {
    console.error("planner order query error", orderRes.error);

    return { order: null, error: orderRes.error.message };
  }

  return { order: (orderRes.data as JsonObject) ?? null, error: null };
}

// Executes ONE domain. Never throws: failures are reported as a domain result so
// the rest of the plan still runs.
async function executeDomain(
  supabase: SupabaseClient,
  domain: string,
  orderLookup: { order: JsonObject | null; error: string | null },
  policyType?: string | null,
): Promise<DomainResult> {
  const orderRow = orderLookup.order;

  try {
    if (domain === "order") {
      // Delegated to the Order Agent (Phase 2C). It runs because the planner
      // selected the `order` domain, and it reuses the shared order lookup.
      const agentResult = runOrderAgent(orderLookup);

      return domainResult("order", agentResult.status as string, agentResult);
    }

    if (domain === "delivery") {
      // Delegated to the Delivery Agent (Phase 2D). It runs because the planner
      // selected the `delivery` domain, reuses the shared order lookup, and
      // structures the existing delivery snapshot without new interpretation.
      const agentResult = runDeliveryAgent(orderLookup);

      return domainResult("delivery", agentResult.status as string, agentResult);
    }

    if (domain === "customer") {
      // Delegated to the Customer Agent (Phase 2B). It only runs because the
      // planner selected the `customer` domain.
      const customerId =
        orderRow && typeof orderRow.customer_id === "string"
          ? orderRow.customer_id
          : null;

      const agentResult = await runCustomerAgent(supabase, customerId);

      return domainResult("customer", agentResult.status as string, agentResult);
    }

    if (domain === "policy") {
      // Delegated to the Policy Agent. It runs because the planner selected the
      // `policy` domain, and retrieves the policy type derived from the
      // validated intent (Phase 12A); matching order is unchanged.
      const agentResult = await runPolicyAgent(supabase, policyType);

      return domainResult("policy", agentResult.status as string, agentResult);
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
  triage: { intent?: string; domains?: string[] },
  orderLookup: { order: JsonObject | null; error: string | null },
  executor?: (domain: string) => Promise<DomainResult>,
): Promise<{
  plan: string[];
  results: DomainResult[];
  investigation: Investigation;
}> {
  const plan = planFromTriage(triage);

  // Optional executor injection point (used for execution tracing); the default
  // keeps the existing behaviour exactly.
  const runDomain =
    typeof executor === "function"
      ? executor
      : (domain: string) => executeDomain(supabase, domain, orderLookup);

  const results = await Promise.all(plan.map((domain) => runDomain(domain)));

  return { plan, results, investigation: buildInvestigation(results) };
}

// Compact, additive view of the executed plan. Includes the agent name when a
// domain was produced by a specialized agent (e.g. the Customer Agent).
function planSummary(results: DomainResult[]): JsonObject[] {
  return results.map((result) => {
    const data = result.data;
    const agent =
      data && typeof data === "object" && !Array.isArray(data) && "agent" in data
        ? (data as JsonObject).agent
        : null;

    return agent
      ? { domain: result.domain, status: result.status, agent }
      : { domain: result.domain, status: result.status };
  });
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
//
// >>> ACTION EXECUTOR (extracted by enterprise-actions.test.mjs)


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

  // Phase 12B: product refund (damaged / wrong product). Uses the same order
  // refund state as the shipping-fee refund, so a completed refund of either
  // kind blocks any further refund on the same order (idempotent).
  if (action === "product_refund") {
    if (!order) {
      return { status: "failed", action, message: "Order information is missing." };
    }

    const { error } = await supabase
      .from("orders")
      .update({ refund_status: "initiated" })
      .eq("order_id", order.order_id);

    if (error) {
      console.error("execute product_refund error", error);
      return { status: "failed", action, message: error.message };
    }

    return {
      status: "completed",
      action,
      order_id: order.order_id,
      refund_status: "initiated",
      message: "Product refund has been initiated.",
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

  // Phase 12B: verification for the product refund mirrors the shipping-fee
  // refund — re-read the order's refund state after the write.
  if (action === "product_refund") {
    if (!order) {
      return { verification_status: "failed" };
    }

    const { data, error } = await supabase
      .from("orders")
      .select("refund_status")
      .eq("order_id", order.order_id)
      .maybeSingle();

    if (error || !data) {
      console.error("verify product_refund error", error);
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

// <<< ACTION EXECUTOR

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

    if (action === "product_refund") {
      return {
        status: "resolved",
        message: `Hi ${customerName}, your product refund for order #${orderId} has been initiated successfully.`,
        details:
          "Your order qualified for a product refund under the applicable policy.",
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

    // Phase 10: read-only replay of a stored execution trace (agent-only).
    // POST support requests are completely unaffected.
    if (req.method === "GET") {
      return await handleTraceRetrieval(req, supabase);
    }

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

    // Phase 9: execution trace — populated from real execution as the pipeline runs.
    const trace = createExecutionTrace(caseId);

    // Step 0: Triage Agent — classify the complaint and produce the
    // investigation plan. Triage can never block the pipeline: on any failure it
    // falls back to deterministic classification. Its output is small, so the
    // call uses a short token cap to stay fast.
    //
    // The order row is fetched in parallel with triage (every plan needs it), so
    // the database round-trip is hidden behind the model call.
    const triageEntry = startTraceStage(trace, "triage");

    const [triageRun, orderLookup] = await Promise.all([
      runTriage(message),
      resolveOrder(supabase, orderId),
    ]);

    const triage = triageRun.triage;
    const triageSource = triageRun.source;

    completeTraceStage(triageEntry, {
      intent: triage.intent,
      urgency: triage.urgency,
      confidence: triage.confidence,
      source: triageSource,
    });

    // Phase 12A: the validated intent determines which policy type applies, so
    // the Policy Agent retrieves the policy relevant to this case.
    const policyType = policyTypeForIntent(triage.intent);

    // Step 1: Dynamic Investigation Plan — execute ONLY the domains triage
    // requested. Independent domains run in parallel and a failing domain
    // degrades safely instead of breaking the request.
    //
    // Each domain execution is traced individually, so the per-agent timing is
    // real; the same traced executor is reused by the re-investigation loop.
    const runTracedDomain = async (domain: string): Promise<DomainResult> => {
      const entry = startTraceStage(trace, domain + "_agent");
      const result = await executeDomain(supabase, domain, orderLookup, policyType);

      finishTraceStage(
        entry,
        traceStatusForDomain(result.status),
        domainStageSummary(result),
      );

      return result;
    };

    const plannerEntry = startTraceStage(trace, "investigation_planner");

    const planRun = await runInvestigationPlan(
      supabase,
      triage,
      orderLookup,
      runTracedDomain,
    );

    completeTraceStage(plannerEntry, { domains: planRun.plan });

    // Domains the plan did not require are recorded as skipped — never invented.
    for (const skippedDomain of missingDomainStages(planRun.plan)) {
      skipTraceStage(trace, skippedDomain + "_agent", { reason: "not_in_plan" });
    }

    // Phase 3: Evidence Engine — normalize the specialized agents' structured
    // results into one evidence set, available internally for future phases.
    // Aggregation only: it decides nothing and never touches the legacy
    // investigation object that the reasoning stage consumes.
    const evidenceEntry = startTraceStage(trace, "evidence_engine");

    const evidenceRun = buildEvidence(
      planRun.results.map((result) => result.data),
    );

    completeTraceStage(evidenceEntry, {
      evidence_count: evidenceRun.evidence.length,
      agents: Object.keys(evidenceRun.agent_status).length,
    });

    // Phase 4: Conflict & Uncertainty Engine — detection only. It reports whether
    // the evidence is contradictory or insufficient for the required domains; it
    // decides nothing and changes no downstream behaviour.
    const healthEntry = startTraceStage(trace, "conflict_uncertainty");

    const healthRun = analyzeEvidence(
      evidenceRun.evidence,
      evidenceRun.agent_status,
      planRun.plan,
    );

    completeTraceStage(healthEntry, {
      conflict_status: healthRun.conflict_status,
      uncertainty_status: healthRun.uncertainty_status,
      requires_reinvestigation: healthRun.requires_reinvestigation,
    });

    // Phase 5: Re-investigation Loop — bounded and deterministic, and only when
    // the health check asked for it. It re-runs just the responsible domains
    // through the existing domain executor and rebuilds evidence; the reasoning
    // stage below is unchanged.
    const reinvestigationEntry = startTraceStage(trace, "reinvestigation");

    const reinvestigation = await runReinvestmentLoop({
      plan: planRun.plan,
      results: planRun.results,
      evidence: evidenceRun.evidence,
      agentStatus: evidenceRun.agent_status,
      health: healthRun,
      maxRounds: MAX_REINVESTIGATION_ROUNDS,
      step: (domains: string[]) =>
        Promise.all(domains.map((domain) => runTracedDomain(domain))),
    });

    finishTraceStage(
      reinvestigationEntry,
      reinvestmentStageStatus(reinvestigation.summary),
      reinvestmentStageSummary(reinvestigation.summary, reinvestigation.rounds),
    );

    // The legacy investigation object is built from the final results. When no
    // round changed anything it is identical to the initial investigation, and it
    // always keeps the exact shape the reasoning prompt expects.
    const investigation = buildInvestigation(reinvestigation.results);

    // Phase 6: Decision Gate — deterministic safety check over the FINAL state
    // (final plan, final agent results, final evidence, final health and the
    // re-investigation outcome).
    //
    // In this phase the gate is a safety/observability layer only: it never makes
    // a business decision and does not alter the existing pipeline, so current API
    // behaviour cannot break. Wiring it to final decision control (including
    // skipping reasoning on BLOCK) is the Decision Agent phase.
    const gateEntry = startTraceStage(trace, "decision_gate");

    const decisionGate = evaluateDecisionGate({
      plan: planRun.plan,
      agentResults: reinvestigation.results,
      evidence: reinvestigation.evidence,
      investigationHealth: reinvestigation.health,
      reinvestigation: reinvestigation.summary,
    });

    finishTraceStage(
      gateEntry,
      decisionGate.status === "BLOCK" ? "blocked" : "completed",
      { status: decisionGate.status, reason: decisionGate.reason },
    );

    // Step 2: build the Qwen reasoning prompt (unchanged)
    const qwenPrompt = buildQwenPrompt(message, investigation);

    // Phase 7: Decision Agent — proposes a validated, evidence-grounded decision
    // from the FINAL state. It runs in parallel with the existing reasoning call
    // (so it adds no latency) and is additive in this phase: the existing
    // reasoning/decision/action path still decides and acts. A BLOCKed gate
    // short-circuits before any LLM call.
    // The Decision Agent is not asked for a decision when the gate blocks it.
    const decisionAgentEntry =
      decisionGate.status === "BLOCK"
        ? skipTraceStage(trace, "decision_agent", {
            reason: "decision_gate_blocked",
          })
        : startTraceStage(trace, "decision_agent");

    const [qwenResult, decisionAgent] = await Promise.all([
      askQwen(qwenPrompt),
      runDecisionAgent({
        gate: decisionGate,
        message,
        plan: planRun.plan,
        evidence: reinvestigation.evidence,
        health: reinvestigation.health,
        order: orderLookup.order,
        policyType,
      }),
    ]);

    if (decisionAgentEntry && decisionAgentEntry.status === "started") {
      finishTraceStage(
        decisionAgentEntry,
        decisionAgent.status === "completed"
          ? "completed"
          : decisionAgent.status === "blocked"
            ? "blocked"
            : "failed",
        {
          status: decisionAgent.status,
          decision:
            typeof decisionAgent.decision === "string"
              ? decisionAgent.decision
              : null,
          action:
            typeof decisionAgent.action === "string" ? decisionAgent.action : null,
          confidence:
            typeof decisionAgent.confidence === "number"
              ? decisionAgent.confidence
              : null,
          evidence_ids: Array.isArray(decisionAgent.evidence_ids)
            ? decisionAgent.evidence_ids
            : [],
          reason:
            typeof decisionAgent.reason === "string" ? decisionAgent.reason : null,
        },
      );
    }

    console.log(
      "triage",
      JSON.stringify({ case_id: caseId, ...triage, source: triageSource }),
    );

    console.log(
      "investigation_plan",
      JSON.stringify({
        case_id: caseId,
        plan: planRun.plan,
        results: planSummary(planRun.results),
      }),
    );

    console.log(
      "evidence",
      JSON.stringify({
        case_id: caseId,
        count: reinvestigation.evidence.length,
        agent_status: reinvestigation.agentStatus,
      }),
    );

    console.log(
      "investigation_health",
      JSON.stringify({
        case_id: caseId,
        conflict_status: reinvestigation.health.conflict_status,
        uncertainty_status: reinvestigation.health.uncertainty_status,
        requires_reinvestigation:
          reinvestigation.health.requires_reinvestigation,
        conflicts: reinvestigation.health.conflicts.length,
        uncertainties: reinvestigation.health.uncertainties.length,
        missing_domains: reinvestigation.health.missing_domains,
        reinvestigation: reinvestigation.summary,
        rounds: reinvestigation.rounds,
      }),
    );

    console.log(
      "decision_gate",
      JSON.stringify({
        case_id: caseId,
        status: decisionGate.status,
        reason: decisionGate.reason,
        reasons: decisionGate.reasons,
      }),
    );

    console.log(
      "decision_agent",
      JSON.stringify({
        case_id: caseId,
        status: decisionAgent.status,
        decision: decisionAgent.decision ?? null,
        action: decisionAgent.action ?? null,
        confidence: decisionAgent.confidence ?? null,
        evidence_ids: decisionAgent.evidence_ids ?? [],
        reason: decisionAgent.reasoning ?? decisionAgent.reason ?? null,
      }),
    );

    // Every successful response carries the triage result, the executed plan, a
    // minimal evidence summary and the investigation health (additive; existing
    // keys and values are unchanged).
    const respond = async (payload: JsonObject) => {
      // The case outcome closes the trace — real statuses only, nothing invented.
      completeTraceStage(startTraceStage(trace, "case_outcome"), {
        status:
          typeof payload.resolution_status === "string"
            ? payload.resolution_status
            : null,
        decision:
          typeof decision.decision === "string" ? decision.decision : null,
        action: typeof decision.action === "string" ? decision.action : null,
      });

      finishExecutionTrace(trace);

      // Phase 10: persist the real execution trace. Best-effort only — a failed
      // write is logged and never changes the outcome, action or decision.
      const tracePersistence = await persistExecutionTrace(supabase, trace);

      console.log(
        "execution_trace_persisted",
        JSON.stringify({
          case_id: caseId,
          ok: tracePersistence.ok,
          reason: tracePersistence.reason,
        }),
      );

      return json({
        ...payload,
        triage,
        triage_source: triageSource,
        investigation_plan: {
          domains: planRun.plan,
          results: planSummary(planRun.results),
        },
        evidence_summary: {
          count: reinvestigation.evidence.length,
          agent_status: reinvestigation.agentStatus,
        },
        investigation_health: {
          conflict_status: reinvestigation.health.conflict_status,
          uncertainty_status: reinvestigation.health.uncertainty_status,
          requires_reinvestigation:
            reinvestigation.health.requires_reinvestigation,
          reinvestigation: {
            performed: reinvestigation.summary.performed,
            rounds: reinvestigation.summary.rounds,
            resolved: reinvestigation.summary.resolved,
            stop_reason: reinvestigation.summary.stop_reason,
          },
        },
        decision_gate: {
          status: decisionGate.status,
          reason: decisionGate.reason,
          reasons: decisionGate.reasons,
        },
        decision_agent: {
          status: decisionAgent.status,
          decision:
            typeof decisionAgent.decision === "string"
              ? decisionAgent.decision
              : null,
          action:
            typeof decisionAgent.action === "string" ? decisionAgent.action : null,
          confidence:
            typeof decisionAgent.confidence === "number"
              ? decisionAgent.confidence
              : null,
          evidence_ids: Array.isArray(decisionAgent.evidence_ids)
            ? decisionAgent.evidence_ids
            : [],
          reason:
            typeof decisionAgent.reasoning === "string"
              ? decisionAgent.reasoning
              : typeof decisionAgent.reason === "string"
                ? decisionAgent.reason
                : null,
        },
        // Phase 8: which decision actually held authority, whether its action was
        // safe to run, and the legacy reasoning kept as compatibility data only.
        decision_authority: {
          status: authority.status,
          decision:
            typeof authority.decision === "string" ? authority.decision : null,
          action: typeof authority.action === "string" ? authority.action : null,
          reason: typeof authority.reason === "string" ? authority.reason : null,
        },
        action_safety: {
          status: actionSafety.status,
          reason:
            typeof actionSafety.reason === "string" ? actionSafety.reason : null,
        },
        legacy_reasoning: {
          valid: legacyValidation.valid,
          decision: legacyValidation.decision,
          action: legacyValidation.action,
        },
        // Phase 9: the real execution trace for this case (additive).
        execution_trace: trace,
      });
    };

    // ---- Phase 8: Decision Authority ------------------------------------
    // The validated Decision Agent is the authoritative source for automated
    // decisions. The legacy reasoning result is kept below as compatibility data
    // only and can never control, override or duplicate an action.
    const authorityEntry = startTraceStage(trace, "decision_authority");

    const authority = resolveAuthoritativeDecision({
      decisionGate,
      decisionAgent,
      // runDecisionAgent only reports "completed" after its own validation passed.
      validation: { valid: decisionAgent.status === "completed" },
      investigation,
      order: orderLookup.order,
    });

    finishTraceStage(
      authorityEntry,
      authority.status === "authorized" ? "completed" : "blocked",
      {
        status: authority.status,
        decision:
          typeof authority.decision === "string" ? authority.decision : null,
        action: typeof authority.action === "string" ? authority.action : null,
        reason: typeof authority.reason === "string" ? authority.reason : null,
      },
    );

    // Only an authorized decision has an action to safety-check; a blocked
    // authority reports its own reason so the cause stays clear.
    const safetyEntry = startTraceStage(trace, "action_safety");

    const actionSafety =
      authority.status === "authorized"
        ? validateAuthorizedAction({
            decision: authority.decision,
            action: authority.action,
            order: orderLookup.order,
            investigation,
            evidence: reinvestigation.evidence,
            plan: planRun.plan,
            policyType,
          })
        : { status: "blocked", reason: authority.reason };

    finishTraceStage(
      safetyEntry,
      actionSafety.status === "allowed" ? "completed" : "blocked",
      {
        status: actionSafety.status,
        reason:
          typeof actionSafety.reason === "string" ? actionSafety.reason : null,
      },
    );

    // The authoritative decision, expressed in the existing legacy vocabulary so
    // the existing response builders, executor and persistence stay unchanged.
    // A blocked/failed authority escalates instead of inventing a business
    // decision, and never falls back to the legacy reasoning action.
    const decision =
      authority.status === "authorized" && actionSafety.status === "allowed"
        ? {
            decision: LEGACY_DECISION_BY_AUTHORITY[authority.decision],
            action: LEGACY_ACTION_BY_AUTHORITY[authority.action],
            reason:
              typeof decisionAgent.reasoning === "string"
                ? decisionAgent.reasoning
                : "Decision Agent authorized this action.",
            evidence: Array.isArray(decisionAgent.evidence_ids)
              ? decisionAgent.evidence_ids
              : [],
            intent: triage.intent || decisionAgent.decision || "",
          }
        : {
            decision: "escalate",
            action: "human_review",
            reason:
              "No automated action was authorized: " +
              (authority.status === "blocked"
                ? authority.reason
                : actionSafety.reason),
            evidence: [],
            intent: triage.intent || "",
          };

    // LEGACY REASONING DATA — informational only, never authoritative.
    const qwenResponse =
      qwenResult.status === "success" ? qwenResult.response : undefined;
    const legacyValidation = validateQwenDecision(qwenResponse);
    const qwenObj = asObject(qwenResponse);

    console.log(
      "decision_authority",
      JSON.stringify({
        case_id: caseId,
        authority,
        action_safety: actionSafety,
        legacy_reasoning: {
          valid: legacyValidation.valid,
          decision: legacyValidation.decision,
          action: legacyValidation.action,
        },
        executed: decision.decision + "/" + decision.action,
      }),
    );

    // Step 9: handle human escalation (authoritative decision)
    if (decision.decision === "escalate") {
      const escalationCase = createEscalationCase({
        customerMessage: message,
        investigation,
        qwenResponse,
        reason:
          typeof decision.reason === "string"
            ? decision.reason
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

      skipTraceStage(trace, "action_executor", { reason: "escalated" });

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
    if (decision.decision === "inform") {
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
          evidence: decision.evidence ?? [],
          intent: decision.intent ?? "",
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
          intent: typeof decision.intent === "string" ? decision.intent : "",
          decision: "escalate",
          reason: escalationReason,
          action: "human_review",
          evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
          action_status: "not_required",
          verification_status: "not_required",
          resolution_status: customerResponse.status,
          escalation_reason: escalationReason,
          case_status: "escalated",
        });

        skipTraceStage(trace, "action_executor", { reason: "escalated" });

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

      skipTraceStage(trace, "action_executor", { reason: "no_action_required" });

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
    const actionEntry = startTraceStage(trace, "action_executor");

    const actionResult = await executeAction(
      supabase,
      decision.action,
      investigation,
    );

    // Step 11: verify that the action actually happened
    const verification = await verifyAction(
      supabase,
      decision.action,
      investigation,
    );

    // Step 12: determine action status
    let actionStatus = "in_progress";
    if (actionResult.status === "completed") {
      actionStatus = "completed";
    } else if (actionResult.status === "failed") {
      actionStatus = "failed";
    }

    completeTraceStage(actionEntry, {
      status: actionStatus,
      action: decision.action,
    });

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