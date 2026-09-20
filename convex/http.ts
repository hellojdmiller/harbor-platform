import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  readBoundedWebhook,
  receiptFromPayload,
  verifySvix,
} from "../lib/integrations/webhooks";

const http = httpRouter();
http.route({
  path: "/webhooks/resend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret)
      return new Response("Webhook is not configured", { status: 503 });
    let payload: string;
    try {
      payload = await readBoundedWebhook(request);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }
    const headers = {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    };
    if (!(await verifySvix(payload, headers, secret)))
      return new Response("Invalid signature", { status: 401 });
    let receipt;
    try {
      receipt = receiptFromPayload(payload, headers.id!);
    } catch {
      return new Response("Invalid event", { status: 400 });
    }
    if (!receipt) return new Response("Event ignored", { status: 202 });
    await ctx.runMutation(internal.integrations.recordEmailEvent, receipt);
    return new Response("Recorded", { status: 200 });
  }),
});
export default http;
