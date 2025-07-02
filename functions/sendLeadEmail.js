import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import * as logger from "firebase-functions/logger";

// Initialize Admin SDK
initializeApp();
const db = getFirestore();

// Define secrets
export const CLIENT_ID = defineSecret("GMAIL_CLIENT_ID");
export const CLIENT_SECRET = defineSecret("GMAIL_CLIENT_SECRET");
export const REFRESH_TOKEN = defineSecret("GMAIL_REFRESH_TOKEN");
export const GMAIL_USER = defineSecret("GMAIL_USER_EMAIL");

export const sendLeadEmail = onDocumentCreated(
  {
    document: "businesses/{bizId}/leadForms/{formId}/leads/{leadId}",
    region: "us-central1",
    secrets: [CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, GMAIL_USER],
  },
  async (event) => {
    const { bizId } = event.params;
    const leadData = event.data?.data?.();

    if (!leadData) {
      logger.error("❌ No lead data found or payload malformed.");
      return;
    }

    try {
      // Fetch business email
      const bizSnap = await db.doc(`businesses/${bizId}`).get();
      const bizEmail = bizSnap.data()?.email;

      if (!bizEmail) {
        logger.error(`❌ No email found at /businesses/${bizId}`);
        return;
      }

      // Format lead fields into HTML
      const leadHTML = Object.entries(leadData)
        .map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`)
        .join("");

      // Set up OAuth2 client
      const oAuth2Client = new google.auth.OAuth2(
        CLIENT_ID.value(),
        CLIENT_SECRET.value(),
        "https://developers.google.com/oauthplayground"
      );
      oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN.value() });

      const accessToken = await oAuth2Client.getAccessToken();

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: GMAIL_USER.value(),
          clientId: CLIENT_ID.value(),
          clientSecret: CLIENT_SECRET.value(),
          refreshToken: REFRESH_TOKEN.value(),
          accessToken: accessToken.token,
        },
      });

      await transporter.sendMail({
        from: `NestorAI <${GMAIL_USER.value()}>`,
        to: bizEmail,
        subject: "📩 New Lead Captured via NestorAI",
        html: `<h2>You've got a new lead!</h2>${leadHTML}`,
      });

      logger.info(`✅ Lead email sent to ${bizEmail}`);
    } catch (err) {
      logger.error("❌ Error sending lead email:", err);
    }
  }
);
