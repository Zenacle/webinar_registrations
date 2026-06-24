require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const csv = require('csv-parser');
const { Readable } = require('stream');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------
// Serve frontend files (index.html, CSS, JS, images) from project root
// ------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', '..')));

// ------------------------------------------------------------------
// Environment & service clients
// ------------------------------------------------------------------
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 5000,
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
} else {
  console.warn('⚠️ RESEND_API_KEY is not defined. Email notifications will be disabled.');
}

const DEFAULT_PRICE = 999; // INR
const ACTIVE_SESSIONS = ['July 05, 2026 · Online'];

const PROMO_DEFINITIONS = {
  ZEN70: { discountPercent: 70, type: 'single' },
  ZEN100: { discountPercent: 100, type: 'single' },
  MATT100: { discountPercent: 100, type: 'limited', limit: 3 },
  MET100: { discountPercent: 100, type: 'limited', limit: 3 },
};

// ------------------------------------------------------------------
// Helper: Fetch Google Sheets survey responses and check completion
// ------------------------------------------------------------------
async function checkSurveyCompletion(email, phone) {
  try {
    const csvUrl = 'https://docs.google.com/spreadsheets/d/12vwgutblI-2qSx1NBfEWgGUhGNpWKiDVcizp9iG2VlU/export?format=csv';
    const response = await axios.get(csvUrl, {
      responseType: 'text',
      timeout: 10000
    });

    return new Promise((resolve, reject) => {
      const results = [];
      const stream = Readable.from(response.data);

      stream.pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
          const targetEmail = (email || '').trim().toLowerCase();
          const cleanRegPhone = (phone || '').replace(/\D/g, '');
          const targetPhoneSuffix = cleanRegPhone.length >= 10 ? cleanRegPhone.slice(-10) : cleanRegPhone;

          const match = results.some(row => {
            const emailKey = Object.keys(row).find(k => k.toLowerCase().includes('email') || k.toLowerCase().includes('mail'));
            const phoneKey = Object.keys(row).find(k => k.toLowerCase().includes('whatsapp') || k.toLowerCase().includes('phone') || k.toLowerCase().includes('contact') || k.toLowerCase().includes('number'));

            let emailMatch = false;
            let phoneMatch = false;

            if (emailKey && targetEmail) {
              const sheetEmail = (row[emailKey] || '').trim().toLowerCase();
              emailMatch = (sheetEmail === targetEmail);
            }

            if (phoneKey && targetPhoneSuffix) {
              const sheetPhoneRaw = (row[phoneKey] || '');
              const cleanSheetPhone = sheetPhoneRaw.replace(/\D/g, '');
              const sheetPhoneSuffix = cleanSheetPhone.length >= 10 ? cleanSheetPhone.slice(-10) : cleanSheetPhone;
              phoneMatch = (sheetPhoneSuffix && sheetPhoneSuffix === targetPhoneSuffix);
            }

            return emailMatch || phoneMatch;
          });

          resolve(match);
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  } catch (error) {
    console.error('Error fetching or parsing survey sheet:', error);
    throw error;
  }
}

// ------------------------------------------------------------------
// Helper: Send Registration Confirmation Email via Resend
// ------------------------------------------------------------------
async function sendRegistrationEmail(registrationData) {
  console.log(`Calling sendRegistrationEmail for ${registrationData?.email || 'unknown'}`);
  if (!resend) {
    const errMsg = `Registration email failed for ${registrationData?.email || 'unknown'}: Resend client not initialized (missing RESEND_API_KEY).`;
    console.error(errMsg);
    console.error("Registration email failed");
    return;
  }

  const fromEmail = process.env.FROM_EMAIL;
  if (!fromEmail) {
    const errMsg = `Registration email failed for ${registrationData?.email || 'unknown'}: FROM_EMAIL is not defined in environment variables.`;
    console.error(errMsg);
    console.error("Registration email failed");
    return;
  }

  const {
    id,
    full_name,
    email,
    phone,
    city,
    specialisation,
    workshop_batch,
    promo_code,
    final_amount
  } = registrationData;

  const subject = 'Registration Confirmed – Climate Reality, Sustainability & Your Role in the Built Environment';

  const textContent = `Hi ${full_name || ''} 👋

Thank you for registering! We're excited to have you with us.

Climate Reality, Sustainability & Your Role in the Built Environment

📅 July 05, 2026
🕚 11:00 AM IST
⏱ 90 Minutes
🎓 Certificate of Participation Included

Registration Summary

Full Name: ${full_name || ''}
Email: ${email || ''}
Phone: ${phone || ''}
City: ${city || ''}
Specialisation: ${specialisation || ''}
Workshop Date: ${workshop_batch || ''}
Promo Code: ${promo_code || 'None'}
Amount Paid: ₹${final_amount !== undefined ? final_amount : '0'}

We'll send the joining link and workshop instructions to your email before the session.

Need help?

📧 [info@zenacle.in](mailto:info@zenacle.in)
📱 WhatsApp: +91 96295 66619
🌐 https://zenacle.in

Regards,
Zenacle Solutions LLP
Nagercoil, Tamil Nadu`;

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registration Confirmed</title>
</head>
<body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f5f7f7; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f5f7f7; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 0;">
    <tr>
      <td align="center" style="padding: 40px 0;">
        <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0, 86, 98, 0.08); border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td align="center" bgcolor="#005662" style="padding: 30px;">
              <img src="https://webinar.zenacle.in/logo_horizontal.png" alt="Zenacle Solutions Logo" height="46" style="display: block; border: 0; height: 46px; max-width: 100%;">
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px; color: #1a2e30; line-height: 1.6;">
              <p style="font-size: 20px; font-weight: bold; color: #003b44; margin-top: 0; margin-bottom: 20px;">Hi ${full_name || ''} 👋</p>
              <p style="font-size: 16px; margin-top: 0; margin-bottom: 25px; color: #1a2e30;">Thank you for registering! We're excited to have you with us.</p>
              
              <!-- Workshop Card -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f0f7f8; border-left: 4px solid #03b3c3; border-radius: 0 6px 6px 0; margin-bottom: 30px; border-collapse: collapse;">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="font-size: 18px; font-weight: bold; color: #005662; margin-top: 0; margin-bottom: 15px;">Climate Reality, Sustainability & Your Role in the Built Environment</h3>
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-size: 15px; color: #1a2e30; padding-bottom: 8px;">📅 July 05, 2026</td>
                      </tr>
                      <tr>
                        <td style="font-size: 15px; color: #1a2e30; padding-bottom: 8px;">🕚 11:00 AM IST</td>
                      </tr>
                      <tr>
                        <td style="font-size: 15px; color: #1a2e30; padding-bottom: 8px;">⏱ 90 Minutes</td>
                      </tr>
                      <tr>
                        <td style="font-size: 15px; color: #1a2e30;">🎓 Certificate of Participation Included</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- Registration Summary -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 30px; border-collapse: collapse;">
                <tr>
                  <td style="padding: 24px;">
                    <h4 style="font-size: 15px; font-weight: bold; color: #003b44; margin-top: 0; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Registration Summary</h4>
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="40%" style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Full Name:</td>
                        <td width="60%" style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${full_name || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Email:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${email || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Phone:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${phone || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">City:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${city || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Specialisation:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${specialisation || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Workshop Date:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${workshop_batch || ''}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; padding-bottom: 10px; vertical-align: top;">Promo Code:</td>
                        <td style="font-size: 14px; color: #1a2e30; padding-bottom: 10px; vertical-align: top;">${promo_code || 'None'}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #5f7477; vertical-align: top;">Amount Paid:</td>
                        <td style="font-size: 14px; font-weight: bold; color: #005662; vertical-align: top;">₹${final_amount !== undefined ? final_amount : '0'}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="font-size: 15px; color: #5f7477; margin-bottom: 25px; margin-top: 0;">We'll send the joining link and workshop instructions to your email before the session.</p>
              
              <!-- Help Section -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-top: 1px solid #e2e8f0; padding-top: 25px; border-collapse: collapse;">
                <tr>
                  <td>
                    <h4 style="font-size: 15px; font-weight: bold; color: #003b44; margin-top: 0; margin-bottom: 12px;">Need help?</h4>
                    <p style="margin: 0 0 8px 0; font-size: 14px;"><a href="mailto:info@zenacle.in" style="color: #005662; text-decoration: none;">📧 info@zenacle.in</a></p>
                    <p style="margin: 0 0 8px 0; font-size: 14px;"><a href="https://wa.me/919629566619" style="color: #005662; text-decoration: none;">📱 WhatsApp: +91 96295 66619</a></p>
                    <p style="margin: 0; font-size: 14px;"><a href="https://zenacle.in" target="_blank" style="color: #005662; text-decoration: none;">🌐 https://zenacle.in</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td bgcolor="#003b44" style="padding: 30px; text-align: center; color: #b3d1d4; font-size: 13px; line-height: 1.5;">
              <p style="margin: 0 0 5px 0;">Regards,</p>
              <p style="margin: 0 0 5px 0; font-weight: bold; color: #ffffff;">Zenacle Solutions LLP</p>
              <p style="margin: 0;">Nagercoil, Tamil Nadu</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const res = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: subject,
      text: textContent,
      html: htmlContent
    });

    if (res && res.error) {
      console.error(`Registration email failed for ${email}`, res.error);
      console.error("Registration email failed");
      return;
    }

    console.log(`Registration email sent to ${email}`);
    console.log("Registration email sent");

    // Update the email_sent flag in the database
    const { error: dbError } = await supabase
      .from('webinar_registrations')
      .update({ email_sent: true })
      .eq('id', id);

    if (dbError) {
      console.error(`Failed to update email_sent flag for ${email} in DB:`, dbError.message || dbError);
    } else {
      console.log(`Email flag updated for ${email}`);
    }
  } catch (error) {
    console.error(`Registration email failed for ${email}`, error);
    console.error("Registration email failed");
  }
}

// ------------------------------------------------------------------
// Helper: Send WhatsApp Confirmation via CRM Integration Endpoint
// ------------------------------------------------------------------
async function sendWhatsAppNotification(registrationData) {
  // Do not call the CRM for pending or failed payments. Only proceed for free_access or paid registrations.
  if (registrationData.payment_status !== 'free_access' && registrationData.payment_status !== 'paid') {
    console.log(`[WhatsApp] Skipping CRM integration for registration ${registrationData.id} (payment_status: ${registrationData.payment_status})`);
    return;
  }

  // Ensure retry-safe behavior:
  // 1. Check if whatsapp_sent is already true in the passed registrationData
  if (registrationData.whatsapp_sent === true) {
    console.log(`[WhatsApp] WhatsApp already sent for registration ${registrationData.id} (skipped).`);
    return;
  }

  // 2. Fetch the latest registration state from database to check whatsapp_sent
  try {
    const { data: latestReg, error: fetchError } = await supabase
      .from('webinar_registrations')
      .select('whatsapp_sent')
      .eq('id', registrationData.id)
      .single();

    if (fetchError) {
      console.error(`[WhatsApp] Failed to fetch latest registration state for retry-safe check:`, fetchError.message || fetchError);
    } else if (latestReg && latestReg.whatsapp_sent === true) {
      console.log(`[WhatsApp] WhatsApp already sent for registration ${registrationData.id} according to DB (skipped).`);
      return;
    }
  } catch (err) {
    console.error(`[WhatsApp] Exception during retry-safe database check for registration ${registrationData.id}:`, err.message || err);
  }

  const crmUrl = process.env.CRM_API_URL || 'https://wacrm.zenacle.in/api/integrations/webinar-registration';
  
  const payload = {
    registration_id: registrationData.id,
    full_name: registrationData.full_name,
    email: registrationData.email,
    phone: registrationData.phone,
    workshop_batch: registrationData.workshop_batch,
    payment_status: registrationData.payment_status,
  };

  const headers = {};
  const crmSecret = process.env.CRM_INTEGRATION_SECRET || process.env.INTEGRATION_SECRET;
  if (crmSecret) {
    headers['Authorization'] = `Bearer ${crmSecret}`;
  }

  try {
    console.log(`[WhatsApp] Triggering CRM integration for registration ${registrationData.id} (${registrationData.email})`);
    const response = await axios.post(crmUrl, payload, { headers, timeout: 15000 });
    
    if (response.data && response.data.success === true) {
      console.log(`[WhatsApp] CRM registration integration succeeded for ${registrationData.email}.`);
      
      const { error } = await supabase
        .from('webinar_registrations')
        .update({ whatsapp_sent: true })
        .eq('id', registrationData.id);
        
      if (error) {
        const dbErrorMsg = `Failed to update whatsapp_sent in DB for registration ${registrationData.id}: ${error.message || JSON.stringify(error)}`;
        console.error(`[WhatsApp] ${dbErrorMsg}`);
        logCRMError(dbErrorMsg, null);
      } else {
        console.log(`[WhatsApp] Successfully updated whatsapp_sent to true for registration ${registrationData.id}`);
      }
    } else {
      const nonSuccessMsg = `CRM integration returned non-success response for ${registrationData.email}: ${JSON.stringify(response.data)}`;
      console.error(`[WhatsApp] ${nonSuccessMsg}`);
      logCRMError(nonSuccessMsg, null);
    }
  } catch (error) {
    const errorMsg = `Failed CRM integration request for ${registrationData.email}`;
    logCRMError(errorMsg, error);
  }
}

// ------------------------------------------------------------------
// Helper: Log CRM integration errors to file and console
// ------------------------------------------------------------------
function logCRMError(message, error) {
  const timestamp = new Date().toISOString();
  let errorDetails = '';
  if (error) {
    if (error.response) {
      errorDetails = `Status: ${error.response.status} - Data: ${JSON.stringify(error.response.data)}`;
    } else {
      errorDetails = error.message || String(error);
    }
  }
  const logLine = `[${timestamp}] ${message} ${errorDetails ? '| Details: ' + errorDetails : ''}\n`;
  console.error(`[CRM Log Error] ${logLine.trim()}`);
  try {
    fs.appendFileSync(path.join(__dirname, 'crm_errors.log'), logLine);
  } catch (fsErr) {
    console.error('Failed to write CRM error to log file:', fsErr.message || fsErr);
  }
}

// ------------------------------------------------------------------
// Helper: Promo validation (server‑side)
// ------------------------------------------------------------------
async function validatePromo(promoCode, email, phone) {
  const code = (promoCode || '').trim().toUpperCase();
  if (!code) {
    return {
      valid: true,
      finalAmount: DEFAULT_PRICE,
      discountPercentage: 0,
      couponType: 'none',
      message: 'No promo code applied.',
    };
  }
  const promo = PROMO_DEFINITIONS[code];
  if (!promo) {
    return { valid: false, message: 'Invalid promo code.' };
  }

  // Custom check for ZEN70 (Google Sheet Survey Completion verification)
  if (code === 'ZEN70') {
    try {
      const isCompleted = await checkSurveyCompletion(email, phone);
      if (!isCompleted) {
        return {
          valid: false,
          message: 'Please complete the career survey to unlock this scholarship.'
        };
      }
    } catch (err) {
      console.error('ZEN70 validation error:', err);
      return {
        valid: false,
        message: 'Could not verify survey completion. Please try again later.'
      };
    }
  }
  // Limited‑use check
  if (promo.type === 'limited') {
    const { count, error } = await supabase
      .from('webinar_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('promo_code', code)
      .in('payment_status', ['free_access', 'success']);
    if (error) {
      console.error('Supabase usage count error:', error);
      return { valid: false, message: 'Server error validating promo.' };
    }
    const used = count ?? 0;
    if (used >= promo.limit) {
      return {
        valid: false,
        message: 'This invitation access code is no longer available.',
      };
    }
  }
  const discount = Math.round((DEFAULT_PRICE * promo.discountPercent) / 100);
  const finalAmount = Math.max(0, DEFAULT_PRICE - discount);
  return {
    valid: true,
    finalAmount,
    discountPercentage: promo.discountPercent,
    couponType: code,
    message: `Promo applied – ${promo.discountPercent}% off.`,
  };
}

// ------------------------------------------------------------------
// Helper: Duplicate registration check
// ------------------------------------------------------------------
async function isDuplicate(email, phone) {
  const { data, error } = await supabase
    .from('webinar_registrations')
    .select('id')
    .eq('email', email)
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('Supabase duplicate check error:', error);
    throw new Error('Database error');
  }
  return !!data;
}

// ------------------------------------------------------------------
// API: Validate promo code
// ------------------------------------------------------------------
app.post('/validate-promo', async (req, res) => {
  const { promoCode, email, phone } = req.body;
  try {
    const result = await validatePromo(promoCode, email, phone);
    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({
      success: true,
      finalAmount: result.finalAmount,
      discountPercentage: result.discountPercentage,
      couponType: result.couponType,
      message: result.message,
    });
  } catch (err) {
    console.error('Validate promo error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ------------------------------------------------------------------
// API: Create Razorpay order (secure)
// ------------------------------------------------------------------
app.post('/create-order', async (req, res) => {
  const { promoCode, leadData } = req.body; // leadData contains all form fields
  if (!leadData || leadData.privacyConsent !== true) {
    return res.status(400).json({ success: false, message: 'Please accept the Privacy Policy to continue.' });
  }
  if (!ACTIVE_SESSIONS.includes(leadData.session)) {
    return res.status(400).json({ success: false, message: 'This workshop session is no longer available.' });
  }
  try {
    // Re‑validate promo on server to avoid tampering
    const promoResult = await validatePromo(promoCode, leadData.email, leadData.phone);
    if (!promoResult.valid) {
      return res.status(400).json({ success: false, message: promoResult.message });
    }
    const amount = promoResult.finalAmount * 100; // paise
    const options = {
      amount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        workshop: 'What Nobody Tells Fresh Engineers',
        email: leadData.email,
        phone: leadData.phone,
        promo_code: promoResult.couponType || '',
      },
    };
    const order = await razorpay.orders.create(options);
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ success: false, message: 'Failed to create order.' });
  }
});

// ------------------------------------------------------------------
// API: Verify payment signature & store registration
// ------------------------------------------------------------------
app.post('/verify-payment', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    leadData,
    promoData,
  } = req.body;

  if (!leadData || leadData.privacyConsent !== true) {
    return res.status(400).json({ success: false, message: 'Please accept the Privacy Policy to continue.' });
  }
  if (!ACTIVE_SESSIONS.includes(leadData.session)) {
    return res.status(400).json({ success: false, message: 'This workshop session is no longer available.' });
  }

  // Double check promo limits if promo is applied
  if (promoData && promoData.couponType) {
    const promoResult = await validatePromo(promoData.couponType, leadData?.email, leadData?.phone);
    if (!promoResult.valid) {
      return res.status(400).json({ success: false, message: promoResult.message });
    }
  }

  const nameParts = (leadData?.fullName || '').split(' ');
  const firstName = leadData?.firstName || nameParts[0] || '';
  const lastName = leadData?.lastName || nameParts.slice(1).join(' ') || '';

  // free‑access shortcut – if final amount is zero
  if (promoData && promoData.finalAmount === 0) {
    try {
      console.log('[Trace 1] Entered free-access branch');
      console.log('[Trace 2] Promo data validated');
      
      if (await isDuplicate(leadData.email, leadData.phone)) {
        return res.status(409).json({ success: false, message: 'You have already registered.' });
      }
      
      console.log('[Trace 3] Building insertPayload');
      const insertPayload = {
        first_name: firstName,
        last_name: lastName,
        full_name: leadData.fullName,
        email: leadData.email,
        phone: leadData.phone,
        city: leadData.city,
        specialisation: leadData.background,
        workshop_batch: leadData.session,
        promo_code: promoData.couponType || null,
        coupon_type: promoData.couponType || null,
        original_amount: DEFAULT_PRICE,
        final_amount: 0,
        discount_percentage: promoData.discountPercentage || 0,
        payment_status: 'free_access',
        payment_method: 'promo_code',
        razorpay_payment_id: `FREE_${promoData.couponType || 'ACCESS'}`,
        razorpay_order_id: 'FREE_ORDER',
        razorpay_signature: 'FREE_SIGNATURE',
        registration_source: 'webinar-landing',
        privacy_consent: leadData.privacyConsent || false,
        consent_given_at: leadData.consentGivenAt || null,
      };
      
      console.log('[Trace 3] insertPayload contents:', JSON.stringify(insertPayload, null, 2));
      console.log('[Trace 4] About to insert into webinar_registrations');
      
      const { data, error } = await supabase.from('webinar_registrations').insert([insertPayload]).select();
      
      if (error) {
        console.log('[Trace 5] Insert failed');
        console.error('Supabase Free Insert Error object:', JSON.stringify(error, null, 2));
        throw error;
      }
      
      console.log('[Trace 5] Insert completed successfully. Returned data:', JSON.stringify(data, null, 2));
      console.log('[Trace 6] About to schedule notifications');
      
      // Trigger email and WhatsApp and await them so they complete in serverless/Vercel environments
      if (data && data[0]) {
        await Promise.all([
          sendRegistrationEmail(data[0]).catch(err => {
            console.error(`Registration email failed for ${data[0].email}:`, err);
          }),
          sendWhatsAppNotification(data[0]).catch(err => {
            console.error(`WhatsApp notification failed for ${data[0].email}:`, err);
          })
        ]);
      }
      
      console.log('[Trace 7] Returning success response');
      return res.json({ success: true, message: 'Registration saved (free access).', paymentId: insertPayload.razorpay_payment_id });
    } catch (e) {
      console.error('Free registration error:', e);
      if (e && e.stack) {
        console.error('Free registration error stack trace:', e.stack);
      }
      return res.status(500).json({ success: false, message: 'Failed to save registration.' });
    }
  }

  // ------------------------------------------------------------
  // 1️⃣ Verify Razorpay signature
  // ------------------------------------------------------------
  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (generatedSignature !== razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
  }

  // ------------------------------------------------------------
  // 2️⃣ Duplicate registration check
  // ------------------------------------------------------------
  try {
    if (await isDuplicate(leadData.email, leadData.phone)) {
      return res.status(409).json({ success: false, message: 'You have already registered.' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Database error.' });
  }

  // ------------------------------------------------------------
  // 3️⃣ Persist registration
  // ------------------------------------------------------------
  const insertPayload = {
    first_name: firstName,
    last_name: lastName,
    full_name: leadData.fullName,
    email: leadData.email,
    phone: leadData.phone,
    city: leadData.city,
    specialisation: leadData.background,
    workshop_batch: leadData.session,
    promo_code: promoData.couponType || null,
    coupon_type: promoData.couponType || null,
    original_amount: DEFAULT_PRICE,
    final_amount: promoData.finalAmount,
    discount_percentage: promoData.discountPercentage,
    payment_status: 'paid',
    payment_method: 'razorpay',
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    registration_source: 'webinar-landing',
    privacy_consent: leadData.privacyConsent || false,
    consent_given_at: leadData.consentGivenAt || null,
  };

  const { data, error } = await supabase.from('webinar_registrations').insert([insertPayload]).select();
  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save registration.' });
  }

  // Trigger email and WhatsApp and await them so they complete in serverless/Vercel environments
  if (data && data[0]) {
    await Promise.all([
      sendRegistrationEmail(data[0]).catch(err => {
        console.error(`Registration email failed for ${data[0].email}:`, err);
      }),
      sendWhatsAppNotification(data[0]).catch(err => {
        console.error(`WhatsApp notification failed for ${data[0].email}:`, err);
      })
    ]);
  }

  res.json({
    success: true,
    message: 'Registration saved.',
    paymentId: razorpay_payment_id,
    amountPaid: promoData.finalAmount,
  });
});

// ------------------------------------------------------------------
// Health check (API only — frontend is served via static middleware)
// ------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend Running Successfully' });
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});