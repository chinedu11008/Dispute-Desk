import type { Address, Order } from '../domain/types.ts';
import type { PayPalGateway } from '../paypal/gateway.ts';
import type { Vault } from '../vault/vault.ts';
import { iso, money, rid } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export const RETURN_POLICY = '30-day returns on unused items; the buyer pays return shipping unless the item is defective';
export type Product = { sku: string; title: string; price: number; listing: string };
export const CATALOG: Product[] = [
  { sku: 'pack-30', title: 'Trailhead 30L Daypack', price: 100, listing: 'Trailhead 30L Daypack, navy, water-resistant (not waterproof) 600D fabric, padded 15-inch laptop sleeve' },
  { sku: 'bottle-1l', title: 'Summit Insulated Bottle 1L', price: 35, listing: 'Summit Insulated Bottle 1L, stainless steel, keeps drinks cold for 24 hours, matte green' },
  { sku: 'lantern', title: 'Ridge LED Lantern', price: 60, listing: 'Ridge LED Lantern, 400 lumens, USB-C rechargeable, collapsible' },
  { sku: 'stand', title: 'Fold-Flat Phone Stand', price: 12, listing: 'Fold-Flat Phone Stand, aluminium, fits phones up to 7 inches' },
];

/** The demo merchant's orders. Capture, shipping and delivery each write to the Evidence Vault as they happen. */
export class OrderBook {
  gateway: PayPalGateway;
  vault: Vault;
  clock: Clock;
  baseUrl: string;
  orders = new Map<string, Order>();
  constructor(gateway: PayPalGateway, vault: Vault, clock: Clock, baseUrl = 'http://localhost:3000') {
    this.gateway = gateway; this.vault = vault; this.clock = clock; this.baseUrl = baseUrl;
  }
  byCapture(capture_id: string) { return [...this.orders.values()].find((o) => o.capture_id === capture_id); }
  byPaypalOrder(paypal_order_id: string) { return [...this.orders.values()].find((o) => o.paypal_order_id === paypal_order_id); }
  get(id: string) { const o = this.orders.get(id); if (!o) throw new Error(`Unknown order ${id}`); return o; }

  async checkout(sku: string, ship_to: Address) {
    const p = CATALOG.find((x) => x.sku === sku);
    if (!p) throw new Error(`Unknown product ${sku}`);
    const id = rid('ord');
    const created = await this.gateway.createOrder({
      reference_id: id, custom_id: id, amount: money(p.price), description: p.title, ship_to,
      return_url: `${this.baseUrl}/paypal/return`, cancel_url: `${this.baseUrl}/`,
    });
    const order: Order = { id, paypal_order_id: created.id, sku, title: p.title, amount: money(p.price), ship_to, status: 'CREATED', created_at: iso(this.clock()) };
    this.orders.set(id, order);
    return { order, approve_url: created.approve_url };
  }

  async capture(paypal_order_id: string, at?: string) {
    const order = this.byPaypalOrder(paypal_order_id);
    if (!order) throw new Error(`No order for PayPal order ${paypal_order_id}`);
    if (order.capture_id) return order;
    const cap = await this.gateway.captureOrder(paypal_order_id);
    order.capture_id = cap.capture_id;
    order.status = 'CAPTURED';
    const product = CATALOG.find((p) => p.sku === order.sku)!;
    const base = { transaction_id: cap.capture_id, source: 'store', captured_at: at };
    this.vault.add({ ...base, kind: 'ORDER_RECEIPT', summary: `Order ${order.id}: ${order.title}, ${order.amount.value} ${order.amount.currency_code}, paid through PayPal`, payload: { order_id: order.id, paypal_order_id, amount: order.amount, ship_to: order.ship_to } });
    this.vault.add({ ...base, kind: 'PRODUCT_SNAPSHOT', summary: product.listing, payload: { sku: product.sku, price: product.price, listing: product.listing } });
    this.vault.add({ ...base, kind: 'POLICY_SNAPSHOT', summary: RETURN_POLICY, payload: { accepted_at_checkout: true } });
    return order;
  }

  async ship(orderId: string, carrier: string, tracking_number: string, at?: string) {
    const o = this.get(orderId);
    if (!o.capture_id) throw new Error('Order has not been captured');
    await this.gateway.addTracking({ transaction_id: o.capture_id, tracking_number, carrier, status: 'SHIPPED' });
    o.status = 'SHIPPED';
    return this.vault.add({ transaction_id: o.capture_id, kind: 'TRACKING', source: 'store', captured_at: at, summary: `${carrier} ${tracking_number}: shipped`, payload: { carrier, tracking_number, status: 'SHIPPED', shipped_at: at ?? iso(this.clock()), verified: false } });
  }

  async deliver(orderId: string, opts: { delivered_at?: string; delivered_to?: Partial<Address>; verified?: boolean; proof?: string } = {}) {
    const o = this.get(orderId);
    const prev = this.vault.latest(o.capture_id!, 'TRACKING');
    if (!prev) throw new Error('Order has not shipped');
    const delivered_at = opts.delivered_at ?? iso(this.clock());
    const { carrier, tracking_number } = prev.payload;
    await this.gateway.addTracking({ transaction_id: o.capture_id!, tracking_number, carrier, status: 'DELIVERED' });
    o.status = 'DELIVERED';
    const item = this.vault.add({
      transaction_id: o.capture_id!, kind: 'TRACKING', source: opts.verified ? 'carrier' : 'store', captured_at: delivered_at,
      summary: `${carrier} ${tracking_number}: delivered`,
      payload: { carrier, tracking_number, status: 'DELIVERED', delivered_at, delivered_to: opts.delivered_to ?? o.ship_to, verified: !!opts.verified },
    });
    if (opts.proof) this.vault.add({ transaction_id: o.capture_id!, kind: 'DELIVERY_PROOF', source: 'carrier', captured_at: delivered_at, summary: opts.proof, payload: {} });
    return item;
  }

  logMessage(orderId: string, summary: string, payload: Record<string, any> = {}, at?: string) {
    const o = this.get(orderId);
    return this.vault.add({ transaction_id: o.capture_id!, kind: 'MESSAGE', source: 'store', captured_at: at, summary, payload });
  }
}
