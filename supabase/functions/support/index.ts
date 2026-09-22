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

// The policy type the existing pipeline matches on. Unchanged.
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
async function runPolicyAgent(supabase: SupabaseClient): Promise<JsonObject> {
  const policyRes = await supabase
    .from("policies")
    .select("*")
    .eq("policy_type", APPLICABLE_POLICY_TYPE)
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
      // Delegated to the Policy Agent (Phase 2E). It runs because the planner
      // selected the `policy` domain and reuses the existing applicable-policy
      // query (matching behavior unchanged).
      const agentResult = await runPolicyAgent(supabase);

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
): Promise<{
  plan: string[];
  results: DomainResult[];
  investigation: Investigation;
}> {
  const plan = planFromTriage(triage);

  const results = await Promise.all(
    plan.map((domain) => executeDomain(supabase, domain, orderLookup)),
  );

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
    const [triageRun, orderLookup] = await Promise.all([
      runTriage(message),
      resolveOrder(supabase, orderId),
    ]);

    const triage = triageRun.triage;
    const triageSource = triageRun.source;

    // Step 1: Dynamic Investigation Plan — execute ONLY the domains triage
    // requested. Independent domains run in parallel and a failing domain
    // degrades safely instead of breaking the request.
    const planRun = await runInvestigationPlan(
      supabase,
      triage,
      orderLookup,
    );

    // Phase 3: Evidence Engine — normalize the specialized agents' structured
    // results into one evidence set, available internally for future phases.
    // Aggregation only: it decides nothing and never touches the legacy
    // investigation object that the reasoning stage consumes.
    const evidenceRun = buildEvidence(
      planRun.results.map((result) => result.data),
    );

    // Phase 4: Conflict & Uncertainty Engine — detection only. It reports whether
    // the evidence is contradictory or insufficient for the required domains; it
    // decides nothing and changes no downstream behaviour.
    const healthRun = analyzeEvidence(
      evidenceRun.evidence,
      evidenceRun.agent_status,
      planRun.plan,
    );

    // Phase 5: Re-investigation Loop — bounded and deterministic, and only when
    // the health check asked for it. It re-runs just the responsible domains
    // through the existing domain executor and rebuilds evidence; the reasoning
    // stage below is unchanged.
    const reinvestigation = await runReinvestmentLoop({
      plan: planRun.plan,
      results: planRun.results,
      evidence: evidenceRun.evidence,
      agentStatus: evidenceRun.agent_status,
      health: healthRun,
      maxRounds: MAX_REINVESTIGATION_ROUNDS,
      step: (domains: string[]) =>
        Promise.all(
          domains.map((domain) => executeDomain(supabase, domain, orderLookup)),
        ),
    });

    // The legacy investigation object is built from the final results. When no
    // round changed anything it is identical to the initial investigation, and it
    // always keeps the exact shape the reasoning prompt expects.
    const investigation = buildInvestigation(reinvestigation.results);

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

    // Every successful response carries the triage result, the executed plan, a
    // minimal evidence summary and the investigation health (additive; existing
    // keys and values are unchanged).
    const respond = (payload: JsonObject) =>
      json({
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