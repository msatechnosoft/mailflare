
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getEmailAddress, getEmailAddressList } from "@/lib/email/address";
import { getResendApiKey } from "@/lib/email/outbound-provider";
import { intakeProviderMail } from "@/lib/email/provider-intake";
import { getReceivedEmail } from "@/lib/email/resend-api";
import { verifySvixSignature } from "@/lib/email/svix";
import { getResendWebhookSecret } from "@/lib/domains/resend-receiving";

export const dynamic = "force-dynamic";

type ReceivedEvent = {
  type?: string;
  data?: { email_id?: string; id?: string };
};

export async function POST(request: Request) {
  const stage = (name: string, details?: unknown) => {
    console.log(`[RESEND INBOUND] ${name}`, details ?? "");
  };

  try {
    stage("START");

    const env = getEnv();
    const secret = await getResendWebhookSecret(env);

    if (!secret) {
      stage("WEBHOOK SECRET MISSING");
      return NextResponse.json(
        { error: "Resend receiving is not set up" },
        { status: 503 }
      );
    }

    const body = await request.text();

    stage("VERIFYING SIGNATURE");

    const valid = await verifySvixSignature(secret, {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    }, body);

    if (!valid) {
      stage("INVALID SIGNATURE");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = JSON.parse(body) as ReceivedEvent;

    if (event.type !== "email.received") {
      stage("IGNORED EVENT");
      return NextResponse.json({ ignored: true });
    }

    const emailId = event.data?.email_id ?? event.data?.id;

    if (!emailId) {
      stage("EMAIL ID MISSING");
      return NextResponse.json({ error: "Missing email id" }, { status: 400 });
    }

    stage("GETTING RESEND API KEY");

    const apiKey = await getResendApiKey(env);

    stage("FETCHING RECEIVED EMAIL");

    const email = await getReceivedEmail(apiKey, emailId);

    stage("RECEIVED EMAIL FETCHED", {
      hasRawDownloadUrl: Boolean(email.raw?.download_url),
    });

    const download = email.raw?.download_url;

    if (!download) {
      return NextResponse.json(
        { error: "Resend did not provide the raw message" },
        { status: 502 }
      );
    }

    stage("DOWNLOADING RAW EMAIL");

    const rawResponse = await fetch(download);

    if (!rawResponse.ok) {
      stage("RAW DOWNLOAD FAILED", { status: rawResponse.status });
      return NextResponse.json(
        { error: "Could not download the raw message" },
        { status: 502 }
      );
    }

    const raw = await rawResponse.arrayBuffer();

    stage("RAW EMAIL DOWNLOADED", { bytes: raw.byteLength });

    const recipients = [
      ...(email.to ?? []),
      ...(email.cc ?? []),
      ...(email.bcc ?? []),
    ].flatMap((value) => getEmailAddressList(value));

    stage("STARTING MAIL INTAKE", {
      recipientCount: recipients.length,
    });

    const result = await intakeProviderMail(env, {
      from: getEmailAddress(email.from),
      recipients,
      raw,
    });

    stage("MAIL INTAKE COMPLETED", result);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[RESEND INBOUND] FAILED", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return NextResponse.json(
      { error: "Incoming email processing failed" },
      { status: 500 }
    );
  }
}
