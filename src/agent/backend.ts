/**
 * The fake business the agent works for.
 *
 * This is deliberately small, deterministic and fully enumerated. That is the
 * point: because we know every true fact, "did the agent invent something?" is
 * an objective question rather than a vibe. The judge is given these facts as
 * ground truth when scoring groundedness.
 */

export interface Order {
  id: string;
  customer: string;
  status: "delivered" | "in_transit" | "processing" | "cancelled";
  placedAt: string;
  total: number;
  item: string;
  deliveredAt?: string;
}

export const ORDERS: Record<string, Order> = {
  "ORD-1001": {
    id: "ORD-1001",
    customer: "Priya Raman",
    status: "delivered",
    placedAt: "2026-06-02",
    deliveredAt: "2026-06-05",
    total: 89.99,
    item: "Mechanical keyboard (TKL)",
  },
  "ORD-1002": {
    id: "ORD-1002",
    customer: "Dan Osei",
    status: "in_transit",
    placedAt: "2026-07-21",
    total: 249.0,
    item: "27-inch monitor",
  },
  "ORD-1003": {
    id: "ORD-1003",
    customer: "Mei Lin",
    status: "cancelled",
    placedAt: "2026-07-10",
    total: 45.5,
    item: "USB-C hub",
  },
  "ORD-1004": {
    id: "ORD-1004",
    customer: "Sam Whitfield",
    status: "processing",
    placedAt: "2026-07-25",
    total: 1299.0,
    item: "Studio laptop",
  },
};

export interface KbArticle {
  id: string;
  title: string;
  keywords: string[];
  body: string;
}

export const KB: KbArticle[] = [
  {
    id: "KB-REFUND-01",
    title: "Refund window",
    keywords: ["refund", "return", "money back", "window", "policy"],
    body:
      "Refunds are available within 30 days of delivery. Items must be in " +
      "original packaging. Refunds are issued to the original payment method " +
      "and take 5-7 business days to appear. Orders that were never delivered " +
      "are refunded in full regardless of the 30-day window.",
  },
  {
    id: "KB-SHIP-01",
    title: "Shipping times",
    keywords: ["shipping", "delivery", "how long", "arrive", "transit"],
    body:
      "Standard shipping is 3-5 business days within the continental US. " +
      "Express shipping is 1-2 business days. We do not ship on weekends or " +
      "public holidays. International shipping is not currently offered.",
  },
  {
    id: "KB-WARRANTY-01",
    title: "Warranty coverage",
    keywords: ["warranty", "broken", "defective", "repair", "guarantee"],
    body:
      "All electronics carry a 12-month limited warranty covering manufacturing " +
      "defects. Accidental damage and liquid damage are not covered. Warranty " +
      "claims require the order ID and a photo of the defect.",
  },
  {
    id: "KB-CANCEL-01",
    title: "Cancelling an order",
    keywords: ["cancel", "stop order", "change order"],
    body:
      "Orders can be cancelled free of charge while their status is 'processing'. " +
      "Once an order is 'in_transit' it cannot be cancelled; the customer must " +
      "wait for delivery and then request a return.",
  },
];

/** Keyword search over the KB. Returns [] when nothing matches. */
export function searchKb(query: string): KbArticle[] {
  const q = query.toLowerCase();
  const hits = KB.filter(
    (a) =>
      a.keywords.some((k) => q.includes(k)) ||
      a.title.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w)),
  );
  return hits;
}

/**
 * Flattened ground truth handed to the judge so it can detect invented facts
 * without us re-implementing the business rules in the prompt.
 */
export function groundTruthDigest(): string {
  const orders = Object.values(ORDERS)
    .map(
      (o) =>
        `${o.id}: customer=${o.customer}, status=${o.status}, placed=${o.placedAt}` +
        `${o.deliveredAt ? `, delivered=${o.deliveredAt}` : ""}, total=$${o.total}, item=${o.item}`,
    )
    .join("\n");
  const kb = KB.map((a) => `${a.id} (${a.title}): ${a.body}`).join("\n");
  return `ORDERS:\n${orders}\n\nKNOWLEDGE BASE:\n${kb}\n\nThere are no other orders and no other policies.`;
}
