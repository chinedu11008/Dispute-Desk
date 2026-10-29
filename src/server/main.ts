import { buildContext } from '../app.ts';
import { createApp } from './http.ts';
import { loadEnv } from '../util/env.ts';

loadEnv();
const ctx = buildContext(process.env);
const port = Number(process.env.PORT ?? 3000);
createApp(ctx).listen(port, () => {
  console.log(`Dispute Desk listening on http://localhost:${port}  (mode ${ctx.mode}, llm ${ctx.llm.name})`);
  if (ctx.mode === 'SIMULATED') console.log('Simulated PayPal: seed a case with  curl -X POST localhost:' + port + '/api/demo/scenario -d \'{"name":"inr-strong"}\'');
  else console.log(`Webhook URL for your sandbox app: <public url>/webhooks/paypal`);
});
