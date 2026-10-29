import type { Dispute, Money } from '../domain/types.ts';
import { PayPalApiError } from './gateway.ts';
import type {
  AcceptClaimInput, AddTrackingInput, CreateOrderInput, Headers, MakeOfferInput, OrderCaptured, OrderCreated, PayPalGateway, ProvideEvidenceInput,
} from './gateway.ts';
import { buildMultipart } from '../util/multipart.ts';
import type { Part } from '../util/multipart.ts';
import { rid } from '../util/ids.ts';

export type LiveOptions = { clientId: string; secret: string; webhookId?: string; baseUrl?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/**
 * Talks to PayPal's sandbox over REST. Written from PayPal's published docs; spikes S1 to S5 confirm each call
 * against a real sandbox account (see docs/SPIKES.md). Never point this at production credentials.
 */
export class LivePayPal implements PayPalGateway {
  mode = 'LIVE_SANDBOX' as const;
  base: string;
  clientId: string;
  secret: string;
  webhookId?: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  token?: { value: string; expires: number };

  constructor(o: LiveOptions) {
    this.clientId = o.clientId; this.secret = o.secret; this.webhookId = o.webhookId;
    this.base = (o.baseUrl ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
    if (!/sandbox/.test(this.base)) throw new Error(`Refusing to use a non-sandbox PayPal URL: ${this.base}`);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw await this.toError(res);
    const data: any = await res.json();
    this.token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async request<T = any>(method: string, path: string, o: { json?: unknown; multipart?: Part[]; headers?: Record<string, string> } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json', ...o.headers };
      let body: BodyInit | undefined;
      if (o.multipart) { const m = buildMultipart(o.multipart); headers['content-type'] = m.contentType; body = m.body as unknown as BodyInit; }
      else if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
      const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body });
      if (res.ok) return res.status === 204 || !(res.headers.get('content-type') ?? '').includes('json') ? (undefined as T) : ((await res.json()) as T);
      if ((res.status === 429 || res.status === 503) && attempt < 3) { await this.sleep(300 * 2 ** attempt); continue; }
      throw await this.toError(res);
    }
  }
  private async toError(res: Response) {
    let b: any = {};
    try { b = await res.json(); } catch { /* not JSON */ }
    const issues = (b.details ?? []).map((d: any) => d.issue).filter(Boolean);
    return new PayPalApiError(res.status, b.name ?? b.error ?? 'HTTP_ERROR', b.message ?? b.error_description ?? res.statusText, issues, res.headers.get('paypal-debug-id') ?? b.debug_id);
  }

  // ---- orders ----
  async createOrder(i: CreateOrderInput): Promise<OrderCreated> {
    const s = i.ship_to;
    const data = await this.request('POST', '/v2/checkout/orders', {
      headers: { 'PayPal-Request-Id': rid('req') },
      json: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: i.reference_id, custom_id: i.custom_id, description: i.description, amount: i.amount,
          shipping: { name: { full_name: s.name ?? 'Customer' }, address: { address_line_1: s.line1, admin_area_2: s.city, admin_area_1: s.state, postal_code: s.postal_code, country_code: s.country_code } },
        }],
        payment_source: { paypal: { experience_context: { return_url: i.return_url, cancel_url: i.cancel_url, user_action: 'PAY_NOW', shipping_preference: 'SET_PROVIDED_ADDRESS' } } },
      },
    });
    const link = (data.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!link) throw new PayPalApiError(502, 'NO_APPROVAL_LINK', 'PayPal returned no approval link for the order');
    return { id: data.id, status: data.status, approve_url: link.href };
  }
  async captureOrder(id: string): Promise<OrderCaptured> {
    const data = await this.request('POST', `/v2/checkout/orders/${id}/capture`, { headers: { 'PayPal-Request-Id': `cap-${id}` }, json: {} });
    const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap) throw new PayPalApiError(502, 'NO_CAPTURE', 'PayPal returned no capture');
    return { id: data.id, status: data.status, capture_id: cap.id, amount: cap.amount };
  }
  async addTracking(i: AddTrackingInput) {
    await this.request('POST', '/v1/shipping/trackers-batch', { json: { trackers: [{ transaction_id: i.transaction_id, tracking_number: i.tracking_number, status: i.status, carrier: i.carrier }] } });
  }
  async refundCapture(captureId: string, amount?: Money) {
    const data = await this.request('POST', `/v2/payments/captures/${captureId}/refund`, { headers: { 'PayPal-Request-Id': rid('rf') }, json: amount ? { amount } : {} });
    return { id: data.id as string };
  }

  // ---- disputes ----
  async listDisputes(q: { disputed_transaction_id?: string } = {}): Promise<Dispute[]> {
    const qs = q.disputed_transaction_id ? `?disputed_transaction_id=${encodeURIComponent(q.disputed_transaction_id)}` : '';
    const data = await this.request('GET', `/v1/customer/disputes${qs}`);
    return (data?.items ?? []) as Dispute[];
  }
  getDispute(id: string): Promise<Dispute> { return this.request('GET', `/v1/customer/disputes/${id}`); }

  private evidenceParts(i: ProvideEvidenceInput): Part[] {
    const files = i.files ?? [];
    const evidences = i.evidences.map((e, n) => (n === 0 && files.length ? { ...e, documents: e.documents ?? files.map((f) => ({ name: f.name })) } : e));
    return [
      { name: 'input', contentType: 'application/json', data: JSON.stringify({ evidences }) },
      ...files.map((f, n) => ({ name: `file${n + 1}`, filename: f.name, contentType: f.content_type, data: f.data })),
    ];
  }
  async provideEvidence(id: string, i: ProvideEvidenceInput) { await this.request('POST', `/v1/customer/disputes/${id}/provide-evidence`, { multipart: this.evidenceParts(i) }); }
  async appeal(id: string, i: ProvideEvidenceInput) { await this.request('POST', `/v1/customer/disputes/${id}/appeal`, { multipart: this.evidenceParts(i) }); }
  async makeOffer(id: string, i: MakeOfferInput) { await this.request('POST', `/v1/customer/disputes/${id}/make-offer`, { json: i }); }
  async acceptClaim(id: string, i: AcceptClaimInput) { await this.request('POST', `/v1/customer/disputes/${id}/accept-claim`, { json: i }); }
  async sendMessage(id: string, message: string) { await this.request('POST', `/v1/customer/disputes/${id}/send-message`, { json: { message } }); }
  async escalate(id: string, note: string) { await this.request('POST', `/v1/customer/disputes/${id}/escalate`, { json: { note } }); }
  async adjudicate(id: string, adjudication_outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR') { await this.request('POST', `/v1/customer/disputes/${id}/adjudicate`, { json: { adjudication_outcome } }); }
  async requireEvidence(id: string, action: 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE') { await this.request('POST', `/v1/customer/disputes/${id}/require-evidence`, { json: { action } }); }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
    if (!this.webhookId) return false;
    const h = (k: string) => String(headers[k] ?? '');
    try {
      const r = await this.request<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', { json: {
        auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
        webhook_id: this.webhookId, webhook_event: JSON.parse(rawBody),
      } });
      return r.verification_status === 'SUCCESS';
    } catch { return false; }
  }
}
