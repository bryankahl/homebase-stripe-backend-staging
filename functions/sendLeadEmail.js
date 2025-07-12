// functions/sendLeadEmail.js
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fetch from "node-fetch";
import * as logger from "firebase-functions/logger";

// Firebase Admin
initializeApp();
const db = getFirestore();

// Define Resend API Key secret
export const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

export const sendLeadEmail = onDocumentCreated(
  {
    document: "businesses/{businessId}/leads/{leadId}",
    secrets: [RESEND_API_KEY],
    region: "us-central1",
  },
  async (event) => {
    const { businessId, leadId } = event.params;
    logger.info(`📄 New Lead Triggered: businessId=${businessId}, leadId=${leadId}`);

    // Log the full event data for safety
    logger.info("🔥 event.data:", JSON.stringify(event.data));

    const firestoreFields = event.data?._fieldsProto;
    if (!firestoreFields) {
      logger.error("❌ No lead data found or payload malformed.");
      return;
    }

    // Extract formId from Firestore fields (if present)
    const formIdField = firestoreFields?.formId;
    const formId =
      formIdField?.stringValue ||
      formIdField?.integerValue ||
      formIdField?.doubleValue ||
      formIdField?.booleanValue ||
      null;

    let displayName = "Unknown Form";
    if (formId) {
      try {
        const formSnap = await db
          .doc(`businesses/${businessId}/leadForms/${formId}`)
          .get();
        if (formSnap.exists) {
          displayName = formSnap.data()?.displayName || "Unnamed Form";
        }
      } catch (err) {
        logger.error("❌ Failed to fetch form display name:", err);
      }
    }

    const emailBody = [];

for (const [fieldId, val] of Object.entries(firestoreFields)) {
  if (["timestamp", "formId"].includes(fieldId)) continue;

  if (val.mapValue && val.mapValue.fields) {
    const label = val.mapValue.fields.label?.stringValue || fieldId;
    const fieldValue = val.mapValue.fields.value;

    let value = "—";

    if (fieldValue?.stringValue !== undefined && fieldValue?.stringValue !== null) {
      value = (fieldValue.stringValue || "").trim() || "—";
    } else if (fieldValue?.arrayValue !== undefined) {
      const arr = fieldValue.arrayValue.values || [];
      const joined = arr
        .map(item =>
          item.stringValue ||
          item.integerValue ||
          item.doubleValue ||
          (item.booleanValue !== undefined ? (item.booleanValue ? "Yes" : "No") : "")
        )
        .filter(v => v !== "")
        .join(", ");
      value = joined || "—";
    } else if (fieldValue?.mapValue !== undefined) {
      // Handle Firestore mapValue for checkbox arrays saved as object
      const vals = Object.values(fieldValue.mapValue.fields || {})
        .map(item => item.stringValue || "")
        .filter(v => v !== "");
      value = vals.length ? vals.join(", ") : "—";
    } else if (fieldValue?.integerValue !== undefined) {
      value = fieldValue.integerValue.toString();
    } else if (fieldValue?.doubleValue !== undefined) {
      value = fieldValue.doubleValue.toString();
    } else if (fieldValue?.booleanValue !== undefined) {
      value = fieldValue.booleanValue ? "Yes" : "No";
    }

    emailBody.push(`<p><strong>${label}:</strong> ${value}</p>`);
  } else {
    const value =
      val.stringValue ||
      val.integerValue ||
      val.doubleValue ||
      (val.booleanValue !== undefined ? (val.booleanValue ? "Yes" : "No") : "—");
    emailBody.push(`<p><strong>${fieldId}:</strong> ${value}</p>`);
  }
}
    

    const leadHTML = emailBody.join("");

    try {
      // Fetch business owner's email
      const bizSnap = await db.doc(`businesses/${businessId}`).get();
      const bizEmail = bizSnap.data()?.email;

      if (!bizEmail) {
        logger.error(`❌ No email found at /businesses/${businessId}`);
        return;
      }

      // Send via Resend
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "NestorAI <support@nestorai.app>",
          to: bizEmail,
          subject: "New Lead Captured via NestorAI",
          html: `
          <div style="border: 1px solid #ccc; padding: 20px; border-radius: 8px; font-family: Arial, sans-serif; background-color: #fafafa;">
            <h2 style="color: #6b1f6a;">You've got a new lead!</h2>
            <p><span style="font-size: 16px; font-weight: bold; color: #6c0;">Form:</span> ${displayName}</p>
            ${leadHTML}
          </div>
          `,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Resend API Error: ${errorText}`);
      }

      logger.info(`✅ Lead email sent via Resend to ${bizEmail}`);
    } catch (err) {
      logger.error("❌ Error sending lead email via Resend:", err);
    }
  }
);
